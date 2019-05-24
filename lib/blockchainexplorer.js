'use strict';

var async = require('async');
var _ = require('lodash');
var $ = require('preconditions').singleton();
var log = require('npmlog');
log.debug = log.verbose;

var db = require('ocore/db.js');
var constants = require('ocore/constants.js');
var ValidationUtils = require("ocore/validation_utils.js");
var async = require('async');
var Obyte = require('obyte');

var BIGINT = 9223372036854775807;

function BlockchainExplorer(opts) {
  var self = this;

  opts = opts || {};
  if (opts.hubUrl) {
    this.hubClient = new Obyte.Client(opts.hubUrl);
    setInterval(() => this.hubClient.api.heartbeat(), 3*1000);
  }
};

function getStrSqlFilterAssetForTransactions(strFilterAsset) {
  if (typeof strFilterAsset === 'undefined' || strFilterAsset === 'all') {
    return "AND (( inputs.asset IS NULL AND outputs.asset IS NULL ) OR (inputs.asset = outputs.asset))";
  } else if (strFilterAsset === null || strFilterAsset === 'bytes' || strFilterAsset === 'base') {
    return "AND inputs.asset IS NULL AND outputs.asset IS NULL";
  } else {
    var strEscapedFilterAsset = db.escape(strFilterAsset);
    return "AND inputs.asset = " + strEscapedFilterAsset + " AND outputs.asset = " + strEscapedFilterAsset;
  }
}

function getStrSqlFilterAssetForSingleTypeOfTransactions(strFilterAsset) {
  if (typeof strFilterAsset === 'undefined' || strFilterAsset === 'all') {
    return "";
  } else if (strFilterAsset === null || strFilterAsset === 'bytes' || strFilterAsset === 'base') {
    return "AND asset IS NULL";
  } else {
    return "AND asset = " + db.escape(strFilterAsset);
  }
}

BlockchainExplorer.prototype.getAddressActivity = function(address, cb) {
  db.query("SELECT 1 FROM outputs WHERE address = ? LIMIT 1", [address], function(outputsRows) {
    if (outputsRows.length === 1)
      cb(null, true);
    else {
      db.query("SELECT 1 FROM unit_authors WHERE address = ? LIMIT 1", [address], function(unitAuthorsRows) {
        cb(null, unitAuthorsRows.length === 1);
      });
    }
  });
}

BlockchainExplorer.prototype.getBalance = function(addresses, opts, handleBalance) {
  if (!addresses)
    return handleBalance("no address");
  if (!ValidationUtils.isNonemptyArray(addresses))
    return handleBalance("addresses must be non-empty array");
  if (!addresses.every(ValidationUtils.isValidAddress))
    return handleBalance("some addresses are not valid");
  if (addresses.length > 100)
    return handleBalance("too many addresses");

  db.query(
    "SELECT address, asset, is_stable, SUM(amount) AS balance, COUNT(*) AS outputs_count \n\
    FROM outputs JOIN units USING(unit) \n\
    WHERE is_spent=0 AND address IN(?) AND sequence='good'" + getStrSqlFilterAssetForSingleTypeOfTransactions(opts.asset) + "\n\
    GROUP BY address, asset, is_stable", [addresses], function (rows) {

      var balances = {};
      rows.forEach(function (row) {
        if (!row.asset && !balances['base'])
          balances['base'] = { stable: 0, pending: 0, stable_outputs_count: 0, pending_outputs_count: 0 };
        if (row.asset && !balances[row.asset])
          balances[row.asset] = { stable: 0, pending: 0, stable_outputs_count: 0, pending_outputs_count: 0 };

        balances[row.asset || 'base'][row.is_stable ? 'stable' : 'pending'] += row.balance;
        balances[row.asset || 'base'][row.is_stable ? 'stable_outputs_count' : 'pending_outputs_count'] += row.outputs_count;
      });

      handleBalance(null, balances);
    }
  );
}

BlockchainExplorer.prototype.getTxHistory = function(addresses, opts, handleHistory) {
  if (!addresses)
    return handleHistory("no address");
  if (!ValidationUtils.isNonemptyArray(addresses))
    return handleHistory("addresses must be non-empty array");
  if (!addresses.every(ValidationUtils.isValidAddress))
    return handleHistory("some addresses are not valid");
  if (addresses.length > 100)
    return handleHistory("too many addresses");

  var strAddressList = addresses.map(db.escape).join(', ');
  var where_condition = "address IN (" + strAddressList + ")";
  var asset_condition = getStrSqlFilterAssetForSingleTypeOfTransactions(opts.asset);
  var cross = "";
  if (opts.unit)
    where_condition += " AND unit=" + db.escape(opts.unit);
  else if (opts.since_mci && ValidationUtils.isNonnegativeInteger(opts.since_mci)) {
    where_condition += " AND main_chain_index>=" + opts.since_mci;
    cross = "CROSS";
  }

  var where_condition_rowid = where_condition;
  if (opts.lastRowId)
    where_condition_rowid = where_condition + " AND units.ROWID<" + opts.lastRowId;

  var limit_condition = " LIMIT " + (constants.MAX_INPUTS_PER_PAYMENT_MESSAGE + constants.MAX_OUTPUTS_PER_PAYMENT_MESSAGE)*2;

  var arrTransactions = [];
  var lastRowId = BIGINT;
  var isEnd = false;

  async.whilst(
    function () {
      return (arrTransactions.length < opts.limit) && !isEnd;
    },

    function (next) {
      db.query(
        "SELECT unit, level, is_stable, sequence, address, \n\
                "+ db.getUnixTimestamp("units.creation_date") + " AS ts, headers_commission+payload_commission AS fee, \n\
                SUM(amount) AS amount, address AS to_address, NULL AS from_address, main_chain_index AS mci, MIN(units.ROWID) as row_id \n\
            FROM units "+ cross + " JOIN outputs USING(unit) \n\
            WHERE " + where_condition_rowid + " " + asset_condition + " \n\
            GROUP BY unit, address \n\
            UNION \n\
            SELECT unit, level, is_stable, sequence, address, \n\
                "+ db.getUnixTimestamp("units.creation_date") + " AS ts, headers_commission+payload_commission AS fee, \n\
                NULL AS amount, NULL AS to_address, address AS from_address, main_chain_index AS mci, units.ROWID as row_id \n\
            FROM units "+ cross + " JOIN inputs USING(unit) \n\
            WHERE " + where_condition_rowid + " " + asset_condition + " \n\
            ORDER BY row_id DESC" + limit_condition,

        function (rows) {
          if (_.isEmpty(rows)) {
            isEnd = true;
            return next();
          }
    
          var assocMovements = {};
          var minRowId = rows[rows.length-1].row_id;
          for (var i = 0; i < rows.length; i++) {
            var row = rows[i];
            if (row.row_id <= minRowId && rows[0].row_id > minRowId)
              continue;
    
            if (!assocMovements[row.unit])
              assocMovements[row.unit] = {
                plus: 0, has_minus: false, ts: row.ts, level: row.level, is_stable: row.is_stable, sequence: row.sequence, fee: row.fee, mci: row.mci, row_id: row.row_id
              };
    
            if (row.to_address) {
              assocMovements[row.unit].plus += row.amount;
              if (!assocMovements[row.unit].arrMyRecipients)
                assocMovements[row.unit].arrMyRecipients = [];
              assocMovements[row.unit].arrMyRecipients.push({ my_address: row.to_address, amount: row.amount });
            }
    
            if (row.from_address) {
              assocMovements[row.unit].has_minus = true;
              if (!assocMovements[row.unit].arrMySenders)
                assocMovements[row.unit].arrMySenders = [];
              assocMovements[row.unit].arrMySenders.push(row.from_address)
            }
            
            if (row.row_id < lastRowId) 
              lastRowId = row.row_id;
          }
    
          where_condition_rowid = where_condition + " AND units.ROWID<" + lastRowId;

          async.forEachOfSeries(
            assocMovements,
            function (movement, unit, cb) {
              if (movement.sequence !== 'good') {
                var transaction = {
                  action: 'invalid',
                  stable: movement.is_stable,
                  unit: unit,
                  fee: movement.fee,
                  time: movement.ts,
                  level: movement.level,
                  mci: movement.mci,
                  asset: opts.asset,
                  rowid: movement.row_id
                };
                arrTransactions.push(transaction);
                if (arrTransactions.length >= opts.limit) {
                  return next();
                }
                cb();
              }
              else if (movement.plus && !movement.has_minus) {
                db.query(
                  "SELECT DISTINCT address FROM inputs WHERE unit=? " + asset_condition + " ORDER BY address",
                  [unit],
                  function (address_rows) {
                    var payers = address_rows.map(function (address_row) { return address_row.address; });
                    var payees = movement.arrMyRecipients.map(function (my_recipient) { return my_recipient.my_address; });
                    var transaction = {
                      action: 'received',
                      amount: movement.plus,
                      payers: payers,
                      payees: payees,
                      stable: movement.is_stable,
                      unit: unit,
                      fee: movement.fee,
                      time: movement.ts,
                      level: movement.level,
                      mci: movement.mci,
                      asset: opts.asset,
                      rowid: movement.row_id
                    };
                    arrTransactions.push(transaction);
                    if (arrTransactions.length >= opts.limit) {
                      return next();
                    }
                    cb();
                  }
                );
              }
              else if (movement.has_minus) {
                var queryString, parameters;
                queryString = "SELECT outputs.address, SUM(outputs.amount) AS amount, outputs.asset, \n\
                  (outputs.address NOT IN(?)) AS is_external \n\
                  FROM outputs \n\
                  WHERE outputs.unit=? \n\
                  GROUP BY outputs.address, asset";
                parameters = [addresses, unit];
                db.query(queryString, parameters,
                  function (payee_rows) {
                    var action = payee_rows.some(function (payee) { return payee.is_external; }) ? 'sent' : 'moved';
                    if (payee_rows.length == 0 || action === 'moved') {
                      return cb();
                    }
                    var has_asset = payee_rows.some(function (payee) { return payee.asset; });
                    if (has_asset && !opts.asset) { // filter out "fees" txs from history
                      return cb();
                    }

                    var amount = 0;
                    var addressTo = [];
                    for (var i = 0; i < payee_rows.length; i++) {
                      var payee = payee_rows[i];
                      if ((action === 'sent' && !payee.is_external) || (opts.asset != payee.asset)) {
                        continue;
                      }
                      amount += payee.amount;
                      addressTo.push(payee.address);
                    }

                    var transaction = {
                      action: action,
                      amount: amount,
                      payers: movement.arrMySenders,
                      payees: addressTo,
                      stable: movement.is_stable,
                      unit: unit,
                      fee: movement.fee,
                      time: movement.ts,
                      level: movement.level,
                      mci: movement.mci,
                      asset: opts.asset,
                      rowid: movement.row_id
                    };
                      
                    arrTransactions.push(transaction);
                    if (arrTransactions.length >= opts.limit) {
                      return next();
                    }
                    cb();
                  }
                );
              }
            },
            function () {
              return next();
            }
          );
        }
      );
    },

    function (err) {
      if (err) handleHistory(err);
      handleHistory(null, arrTransactions);
    }
  );
}

BlockchainExplorer.prototype.getUtxos = function(addresses, asset, handleUtxos) {
  if (!addresses)
    return handleUtxos("no address");
  if (!ValidationUtils.isNonemptyArray(addresses))
    return handleUtxos("addresses must be non-empty array");
  if (!addresses.every(ValidationUtils.isValidAddress))
    return handleUtxos("some addresses are not valid");
  if (addresses.length > 100)
    return handleUtxos("too many addresses");

  db.query(
    "SELECT * FROM outputs JOIN units USING(unit) \n\
    WHERE is_spent=0 AND address IN(?) AND sequence='good'" + getStrSqlFilterAssetForSingleTypeOfTransactions(asset), 
    [addresses], function (rows) {
      handleUtxos(null, rows);
    }
  );
}

BlockchainExplorer.prototype.getTransaction = function(unit, handleTx) {
  db.query('SELECT * FROM units WHERE unit = ? LIMIT 1', [unit], function (rows) {
    if (rows.length > 0) {
      return handleTx(null, rows[0]);
    } else {
      return handleTx(null, null);
    }
  });
}

BlockchainExplorer.prototype.broadcastJoint = function(joint, cb) {
  this.hubClient.api.postJoint(joint, cb);
}

module.exports = BlockchainExplorer;