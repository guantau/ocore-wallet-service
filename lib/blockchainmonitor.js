'use strict';

var $ = require('preconditions').singleton();
var _ = require('lodash');
var async = require('async');
var log = require('npmlog');
log.debug = log.verbose;

var Storage = require('./storage');
var MessageBroker = require('./messagebroker');
var Lock = require('./lock');
var Notification = require('./model/notification');
var Asset = require('./model/asset');
var Common = require('./common');
var Utils = Common.Utils;

const conf = require('ocore/conf.js');
const eventBus = require('ocore/event_bus.js');
const network = require('ocore/network.js');
const ocoreStorage = require('ocore/storage.js');
const db = require('ocore/db.js');
const validationUtils = require('ocore/validation_utils.js');
var myWitnesses = require('ocore/my_witnesses.js');
var desktopApp = require('ocore/desktop_app.js');

var fs = require('fs');
var util = require('util');

var appDataDir = desktopApp.getAppDataDir();

const arrRegistryAddresses = Object.keys(conf.trustedRegistries);
network.setWatchedAddresses(arrRegistryAddresses);


function replaceConsoleLog () {
  var log_filename = conf.LOG_FILENAME || (appDataDir + '/log.txt');
	var writeStream = fs.createWriteStream(log_filename);
	console.log('---------------');
	console.log('From this point, output will be redirected to '+log_filename);
	console.log("To release the terminal, type Ctrl-Z, then 'bg'");
	console.log = function(){
		writeStream.write(Date().toString()+': ');
		writeStream.write(util.format.apply(null, arguments) + '\n');
	};
	console.warn = console.log;
	console.info = console.log;
}


function BlockchainMonitor() {};

BlockchainMonitor.prototype.start = function(opts, cb) {
  opts = opts || {};

  var self = this;

  async.series([

    function(done) {
      if (opts.storage) {
        self.storage = opts.storage;
        done();
      } else {
        self.storage = new Storage();
        self.storage.connect(opts.storageOpts, done);
      }
    },

    function(done) {
      self.messageBroker = opts.messageBroker || new MessageBroker(opts.messageBrokerOpts);
      done();
    },

    function(done) {
      self.lock = opts.lock || new Lock(self.storage, opts.lockOpts);
      done();
    },

    function(done) {
      myWitnesses.readMyWitnesses(function(arrWitnesses) {
        if (arrWitnesses.length > 0) {
          self._startHub();
          done();
        } else {
          log.info('will init witnesses', conf.initial_witnesses);
          myWitnesses.insertWitnesses(conf.initial_witnesses, self._startHub);
          done();
        }
      }, 'ignore');
    }

  ], function(err) {
    if (err) {
      log.error(err);
    }
    return cb(err);
  });

};

BlockchainMonitor.prototype._startHub = function(done) {
  log.info('starting hub');

  replaceConsoleLog();
  var self = this;
  self._scanPastMetadataUnits();

  if (conf.initial_peers) {
    conf.initial_peers.forEach(function (url) {
      network.findOutboundPeerOrConnect(url);
    });
  }

  eventBus.on('my_transactions_became_stable', function(arrUnits) {
    log.info("units that affect watched addresses: "+arrUnits.join(', '));
    arrUnits.forEach(unit => {
      self._handlePotentialAssetMetadataUnit(unit);
    });
  });

  eventBus.on('new_joint', function (objJoint) {
    self._handleNewJoint(objJoint);
  });

  eventBus.on('mci_became_stable', function (mci) {
    self._handleStableJoint(mci);
  });
}

BlockchainMonitor.prototype._handlePotentialAssetMetadataUnit = function(unit) {
  var self = this;
  
  var asset;
	ocoreStorage.readJoint(db, unit, {
		ifNotFound: function(){
			log.error("unit "+unit+" not found");
		},
		ifFound: function(objJoint){
      log.info('handle potential asset metadata unit: '+unit);
      let objUnit = objJoint.unit;
			let arrAuthorAddresses = objUnit.authors.map(author => author.address);
			if (arrAuthorAddresses.length !== 1)
				return log.error("ignoring multi-authored unit "+unit);
			let registry_address = arrAuthorAddresses[0];
			let registry_name = conf.trustedRegistries[registry_address];
			if (!registry_name)
        return log.error("not authored by registry: "+unit);
        
			let arrAssetMetadataPayloads = [];
			objUnit.messages.forEach(message => {
				if (message.app !== 'data')
					return;
				let payload = message.payload;
				if (!payload.asset || !payload.name)
					return log.error("found data payload that is not asset metadata");
				arrAssetMetadataPayloads.push(payload);
      });
      
			if (arrAssetMetadataPayloads.length === 0)
				return log.error("no asset metadata payload found");
			if (arrAssetMetadataPayloads.length > 1)
				return log.error("multiple asset metadata payloads not supported, found "+arrAssetMetadataPayloads.length);
      
      let payload = arrAssetMetadataPayloads[0];
			if ("decimals" in payload && !validationUtils.isNonnegativeInteger(payload.decimals))
				return log.error("invalid decimals in asset metadata of unit "+unit);
      
      let suffix = null;
      let attributes = {};

      function readMetadata(cb) {

        async.series([

          function (next) {
            self.storage.fetchAssetByUnit(payload.asset, function (err, result) {
              if (err) return next(err);
              if (result) 
                return next("registry "+registry_address+" attempted to register asset "+payload.asset+" again, old name "+result[0].name+" by "+result[0].registry_address+", new name "+payload.name);
              next();
            });
          },

          function (next) {
            var filter = {
              name: payload.name,
              registryAddress: {$ne: registry_address}
            };
            self.storage.fetchAssetByFilter(filter, function (err, result) {
              if (err) return next(err);
              if (result) suffix = registry_name;
              next();
            });
          },

          function (next) {
            var filter = {
              name: payload.name,
              registryAddress: registry_address
            };
            self.storage.fetchAssetByFilter(filter, function (err, result) {
              if (err) return next(err);
              if (result) {
                var bSame = (result[0].asset === payload.asset);
                if (bSame) {
                  return next("asset "+payload.asset+" already registered by the same registry "+registry_address+" by the same name "+payload.name);
                } else {
                  return next("registry "+registry_address+" attempted to register the same name "+payload.name+" under another asset "+payload.asset+" while the name is already assigned to "+result[0].asset);
                }
              }
              next();
            });
          },

          function (next) {
            asset = Asset.create({
              asset: payload.asset,
              name: payload.name,
              shortName: payload.shortName,
              ticker: payload.ticker,
              issuer: payload.issuer,
              decimals: payload.decimals,
              description: payload.description,
              suffix: suffix,
              registryAddress: registry_address,
              metadataUnit: unit,
              cap: parseInt(attributes.cap),
              private: attributes.is_private,
              transferrable: attributes.is_transferrable,
              autoDestroy: attributes.auto_destroy,
              fixedDenominations: attributes.fixed_denominations,
              issuedByDefinerOnly: attributes.issued_by_definer_only,
              cosignedByDefiner: attributes.cosigned_by_definer,
              spenderAttested: attributes.spender_attested,
              issueCondition: attributes.issue_condition,
              transferCondition: attributes.transfer_condition
            });
            next();
          }

        ], function (err) {
          if (err) return cb(err);
          return cb(null, asset);
        });
      }

			db.query("SELECT * FROM assets WHERE unit=?", [payload.asset], rows => {
				if (rows.length === 0)
          return log.error("asset "+payload.asset+" not found");
        
        attributes = rows[0];

        if (attributes.fixed_denominations) {
          db.query("SELECT * FROM asset_denominations where asset=?", [payload.asset], rows => {
            attributes.denominations = {};
            rows.forEach(row => {
              attributes.denominations[row.denomination] = row.count_coins;
            });
            readMetadata(function(err, asset) {
              if (err) return log.error(err);
              self.storage.storeAsset(asset, function() {
                return;
              });
            });
          });
        } else {
          readMetadata(function(err, asset) {
            if (err) return log.error(err);
            self.storage.storeAsset(asset, function() {
              return;
            });
          });
        }
			});
		}
	});
}

BlockchainMonitor.prototype._scanPastMetadataUnits = function() {
  var self = this;

	db.query("SELECT unit FROM unit_authors WHERE address IN(?)", [arrRegistryAddresses], rows => {
    let arrUnits = rows.map(row => row.unit);
		arrUnits.forEach(unit => {
      self._handlePotentialAssetMetadataUnit(unit);
    });
	});
}

BlockchainMonitor.prototype._getUnitOutputs = function(objUnit) {
  var arrOutputs = [];
  if (!objUnit.messages) // voided unit
    return arrOutputs;
  for (var i = 0; i < objUnit.messages.length; i++) {
    var message = objUnit.messages[i];
    if (message.app !== "payment" || !message.payload)
      continue;
    var payload = message.payload;
    var asset = payload.asset ? payload.asset : null;
    for (var j=0; j<payload.outputs.length; j++) {
      var address = payload.outputs[j].address;
      var amount = payload.outputs[j].amount;
      if (arrOutputs.indexOf(address) === -1)
      arrOutputs.push({asset: asset, address: address, amount: amount});
    }
  }
  return arrOutputs;
}

BlockchainMonitor.prototype._handleNewJoint = function(objJoint) {
  var self = this;

  var objUnit = objJoint.unit;
  if (!objUnit || !objUnit.unit) return;

  self.storage.fetchTxByHash(objUnit.unit, function(err, txp) {
    if (err) {
      log.error('Could not fetch tx from the db: ' + err);
      return;
    }

    var outputs = self._getUnitOutputs(objUnit);
    if (!txp) {
      // TODO: if any of the authors is in our database, the unit may be outgoing from third party
      async.each(outputs, function(output, next) {
        self.storage.fetchAddressByCoin('obyte', output.address, function(err, address) {
          if (err) {
            log.error('Could not fetch addresses from the db');
            return next(err);
          }

          if (!address) return next();
          self._storeActiveAddresses(output.address);
          if (address.isChange) return next();
    
          var walletId = address.walletId;
          log.info('Incoming tx for wallet ' + walletId + ' [' + addr + ']');
    
          var fromTs = Date.now() - 24 * 3600 * 1000;
          self.storage.fetchNotifications(walletId, null, fromTs, function(err, notifications) {
            if (err) return next(err);
            var alreadyNotified = _.some(notifications, function(n) {
              return n.type == 'NewIncomingTx' && n.data && n.data.txid == objUnit.unit;
            });
            if (alreadyNotified) {
              log.info('The incoming tx ' + objUnit.unit + ' was already notified');
              return next();
            }
    
            var notification = Notification.create({
              type: 'NewIncomingTx',
              data: {
                txid: objUnit.unit,
                asset: output.asset,
                address: output.address,
                amount: output.amount
              },
              walletId: walletId,
            });
    
            self._storeAndBroadcastNotification(notification, next);
          });
        });
      }, function(err) {
        return;
      });

    } else {
      self.lock.runLocked(objJoint.unit.unit, {}, 
        function(err) {
          if (err) {
            log.error('Acquire lock error:' + err);
            return;
          }
        },
        function() {
          if (txp.status != 'accepted') return;

          var walletId = txp.walletId;

          log.info('Processing accepted txp [' + txp.id + '] for wallet ' + walletId);

          var fromTs = Date.now() - 24 * 3600 * 1000;
          self.storage.fetchNotifications(walletId, null, fromTs, function(err, notifications) {
            if (err) return next(err);
            var alreadyNotified = _.some(notifications, function(n) {
              return (n.type == 'NewOutgoingTx' || n.type == 'NewOutgoingTxByThirdParty') && n.data && n.data.txid == objUnit.unit;
            });
            if (alreadyNotified) {
              log.info('The incoming tx ' + objUnit.unit + ' was already notified');
              return;
            }

            txp.setBroadcasted();
            self.storage.storeTx(walletId, txp, function(err) {
              if (err)
                log.error('Could not save TX');
        
              var args = {
                txProposalId: txp.id,
                creatorId: txp.creatorId,
                txid: objUnit.unit,
                asset: txp.asset,
                amount: txp.getTotalAmount(),
                message: txp.message
              };
        
              var notification = Notification.create({
                type: 'NewOutgoingTx',
                data: args,
                walletId: walletId,
                creatorId: txp.creatorId,
              });
              self._storeAndBroadcastNotification(notification);

              var authorAddresses = objUnit.authors.map(function(author){ return author.address; });
              var outputAddresses = outputs.map(function(output){ return output.address; });
              self._storeActiveAddresses(_.union(authorAddresses, outputAddresses));
            });
          });
        }
      );
    }
  });
}

BlockchainMonitor.prototype._handleStableJoint = function(mci) {
  var self = this;

  db.query(
    "SELECT * FROM units WHERE main_chain_index=? AND sequence='good'",
    [mci],
    function (rows) {
      if (rows.length > 0) {
        function processTriggeredSubs(subs, cb) {
          async.each(subs, function(sub) {
            log.info('New tx confirmation ' + sub.txid);
            sub.isActive = false;
            self.storage.storeTxConfirmationSub(sub, function(err) {
              if (err) return cb(err);
      
              var notification = Notification.create({
                type: 'TxConfirmation',
                walletId: sub.walletId,
                creatorId: sub.copayerId,
                data: {
                  txid: sub.txid,
                  coin: coin,
                  network: network,
                },
              });
              self._storeAndBroadcastNotification(notification, cb);
            });
          });
        };

        async.series([

          function(done) {
            async.each(rows, function(row, next) {
              self.storage.fetchTxByHash(row.unit, function(err, txp) {
                if (err) {
                  log.error('Could not fetch tx from the db: ' + err);
                  next(err);
                }
                if (txp) {
                  log.info(row.unit + ' reach stable:' + 'mci=' + row.main_chain_index + ', level=' + row.level);
                  txp.setStable();
                  self.storage.storeTx(txp.walletId, txp, function(err) {
                    if (err){
                      log.error('Could not save tx:' + row.unit);
                      next(err);
                    }
                    next();
                  });
                } else {
                  next();
                }
              });
            }, function(err) {
              done(err);
            });
          },

          function(done) {
            self.storage.fetchActiveTxConfirmationSubs(null, function(err, subs) {
              if (err) done(err);
              if (_.isEmpty(subs)) done();
              var indexedSubs = _.keyBy(subs, 'txid');
              var triggered = [];
              _.each(rows, function(row) {
                if (indexedSubs[row.unit]) triggered.push(indexedSubs[txid]);
              });
              processTriggeredSubs(triggered, function(err) {
                if (err) {
                  log.error('Could not process tx confirmations', err);
                  done(err);
                }
                done();
              });
            });
          },
      
        ], function(err) {
          if (err) {
            log.error(err);
          }
          return;
        });
      }
    }
  );
}

BlockchainMonitor.prototype._storeAndBroadcastNotification = function(notification, cb) {
  var self = this;

  self.storage.storeNotification(notification.walletId, notification, function() {
    self.messageBroker.send(notification)
    if (cb) return cb();
  });
};

BlockchainMonitor.prototype._storeActiveAddresses = function(addresses, cb) {
  var self = this;

  self.storage.markActiveAddresses(addresses, function() {
    if (cb) return cb();
  });
};

module.exports = BlockchainMonitor;