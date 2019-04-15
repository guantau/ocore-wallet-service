'use strict';

var _ = require('lodash');
var $ = require('preconditions').singleton();
var Uuid = require('uuid');
var log = require('npmlog');
log.debug = log.verbose;
log.disableColor();

var Bitcore = require('bitcore-lib');
var ObjectHash = require('ocore/object_hash');
var EcdsaSig = require('ocore/signature');

var Common = require('../common');
var Constants = Common.Constants,
  Defaults = Common.Defaults,
  Utils = Common.Utils;

var TxProposalAction = require('./txproposalaction');

function TxProposal() { };

TxProposal.create = function (opts) {
  opts = opts || {};

  $.checkArgument(Utils.checkValueInCollection(opts.coin, Constants.COINS));
  $.checkArgument(Utils.checkValueInCollection(opts.network, Constants.NETWORKS));

  var x = new TxProposal();

  x.version = 1;

  var now = Date.now();
  x.createdOn = Math.floor(now / 1000);
  x.id = opts.id || Uuid.v4();
  x.walletId = opts.walletId;
  x.creatorId = opts.creatorId;
  x.coin = opts.coin;
  x.network = opts.network;
  x.message = opts.message;
  x.changeAddress = opts.changeAddress;
  x.walletM = opts.walletM;
  x.walletN = opts.walletN;
  x.requiredSignatures = x.walletM;
  x.requiredRejections = Math.min(x.walletM, x.walletN - x.walletM + 1);
  x.status = 'temporary';
  x.stable = 0;
  x.actions = [];
  // x.spendUnconfirmed = opts.spendUnconfirmed;

  x.addressType = opts.addressType || (x.walletN > 1 ? Constants.ADDRESS_TYPES.SHARED : Constants.ADDRESS_TYPES.NORMAL);
  $.checkState(Utils.checkValueInCollection(x.addressType, Constants.ADDRESS_TYPES));

  x.customData = opts.customData;
  x.app = opts.app || 'payment';
  x.appdata = opts.adddata || {};
  x.asset = opts.asset || null;
  x.unit = opts.unit;
  x.signingInfo = opts.signingInfo;

  return x;
};

TxProposal.fromObj = function (obj) {
  var x = new TxProposal();

  x.version = obj.version;
  x.createdOn = obj.createdOn;
  x.id = obj.id;
  x.walletId = obj.walletId;
  x.creatorId = obj.creatorId;
  x.coin = obj.coin || Defaults.COIN;
  x.network = obj.network;
  x.message = obj.message;
  x.changeAddress = obj.changeAddress;
  x.walletM = obj.walletM;
  x.walletN = obj.walletN;
  x.requiredSignatures = obj.requiredSignatures;
  x.requiredRejections = obj.requiredRejections;
  x.status = obj.status;
  x.stable = obj.stable;
  x.txid = obj.txid;
  x.broadcastedOn = obj.broadcastedOn;
  x.stabledOn = obj.stabledOn;
  x.actions = _.map(obj.actions, function (action) {
    return TxProposalAction.fromObj(action);
  });
  // x.spendUnconfirmed = obj.spendUnconfirmed;
  x.addressType = obj.addressType;
  x.customData = obj.customData;
  x.app = obj.app || 'payment';
  x.appdata = obj.appdata || {};
  x.asset = obj.asset || null;
  x.unit = JSON.parse(obj.unit);
  x.signingInfo = obj.signingInfo;

  x.proposalSignature = obj.proposalSignature;
  x.proposalSignaturePubKey = obj.proposalSignaturePubKey;
  x.proposalSignaturePubKeySig = obj.proposalSignaturePubKeySig;

  return x;
};

TxProposal.prototype.toObject = function () {
  var x = _.cloneDeep(this);
  x.unit = JSON.stringify(this.unit);
  x.actions = _.map(this.actions, function (action) {
    return action.toObject();
  });
  x.isPending = this.isPending();
  return x;
};

TxProposal.prototype._updateStatus = function () {
  if (this.status != 'pending') return;

  if (this.isRejected()) {
    this.status = 'rejected';
  } else if (this.isAccepted()) {
    this.status = 'accepted';
  }
};

TxProposal.prototype._getCurrentSignatures = function () {
  var acceptedActions = _.filter(this.actions, {
    type: 'accept'
  });

  return _.map(acceptedActions, function (x) {
    return {
      signatures: x.signatures,
      xpub: x.xpub,
    };
  });
};

TxProposal.prototype.getTotalAmount = function () {
  var objUnit = this.unit;
  if (!objUnit.messages) // voided unit
    return 0;

  var amount = 0;
  for (var i=0; i<objUnit.messages.length; i++){
    var message = objUnit.messages[i];
    if (message.app !== "payment" || !message.payload)
      continue;
    var payload = message.payload;
    var asset = payload.asset ? payload.asset : null;
    if (this.asset && this.asset != asset) 
      continue;
    for (var j=0; j<payload.outputs.length; j++) {
      if (this.changeAddress.address != payload.outputs[j].address)
        amount += payload.outputs[j].amount;
    }
  }

  return amount;
};

/**
 * getActors
 *
 * @return {String[]} copayerIds that performed actions in this proposal (accept / reject)
 */
TxProposal.prototype.getActors = function () {
  return _.map(this.actions, 'copayerId');
};

/**
 * getApprovers
 *
 * @return {String[]} copayerIds that approved the tx proposal (accept)
 */
TxProposal.prototype.getApprovers = function () {
  return _.map(
    _.filter(this.actions, {
      type: 'accept'
    }), 'copayerId');
};

/**
 * getActionByCopayer
 *
 * @param {String} copayerId
 * @return {Object} type / createdOn
 */
TxProposal.prototype.getActionByCopayer = function (copayerId) {
  return _.find(this.actions, {
    copayerId: copayerId
  });
};

TxProposal.prototype.getActionByAddress = function (address) {
  return _.find(this.actions, {
    address: address
  });
}

TxProposal.prototype.addAction = function (copayerId, type, comment, signatures, xpub) {
  var action = TxProposalAction.create({
    copayerId: copayerId,
    type: type,
    signatures: signatures,
    xpub: xpub,
    comment: comment,
  });
  this.actions.push(action);
  this._updateStatus();
};

TxProposal.prototype._addSignaturesToUnit = function (walletId, signatures, xpub) {
  var self = this;

  var cnt = _.countBy(self.signingInfo, function (address) {
    return (address.walletId == walletId);
  }).true;

  if (Object.keys(signatures).length != cnt)
    throw new Error('Number of signatures does not match number of authors');

  var i = 0;
  var x = Bitcore.HDPublicKey(xpub);
  var hash = ObjectHash.getUnitHashToSign(self.unit);

  _.each(self.unit.authors, function (author) {
    if (author.address in signatures) {
      var pub = x.deriveChild(self.signingInfo[author.address].path).publicKey;
      _.each(signatures[author.address], function(sig) {
        if (!EcdsaSig.verify(hash, sig, pub.toBuffer().toString('base64'))) 
          throw new Error('Wront signature');
      });
      author.authentifiers = signatures[author.address];
      i++;
    }
  });

  if (i != Object.keys(signatures).length)
    throw new Error('Wrong signatures');
};

TxProposal.prototype.sign = function (copayerId, walletId, signatures, xpub) {
  try {
    this._addSignaturesToUnit(walletId, signatures, xpub);
    this.addAction(copayerId, 'accept', null, signatures, xpub);

    if (this.status == 'accepted') {
      this.unit.unit = ObjectHash.getUnitHash(this.unit);
      this.txid = this.unit.unit;
    }

    return true;
  } catch (e) {
    log.debug(e);
    return false;
  }
};

TxProposal.prototype.reject = function (copayerId, reason) {
  this.addAction(copayerId, 'reject', reason);
};

TxProposal.prototype.isTemporary = function () {
  return this.status == 'temporary';
};

TxProposal.prototype.isPending = function () {
  return !_.includes(['temporary', 'broadcasted', 'rejected'], this.status);
};

TxProposal.prototype.isAccepted = function () {
  var votes = _.countBy(this.actions, 'type');
  return votes['accept'] >= this.requiredSignatures;
};

TxProposal.prototype.isRejected = function () {
  var votes = _.countBy(this.actions, 'type');
  return votes['reject'] >= this.requiredRejections;
};

TxProposal.prototype.isBroadcasted = function () {
  return this.status == 'broadcasted';
};

TxProposal.prototype.setBroadcasted = function () {
  $.checkState(this.txid);
  this.status = 'broadcasted';
  this.broadcastedOn = Math.floor(Date.now() / 1000);
};

TxProposal.prototype.isStable = function () {
  return this.stable == 1;
};

TxProposal.prototype.setStabled = function () {
  $.checkState(this.txid);
  this.stable = 1;
  this.stabledOn = Math.floor(Date.now() / 1000);
};

module.exports = TxProposal;
