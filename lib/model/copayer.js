'use strict';

var $ = require('preconditions').singleton();
var crypto = require('crypto');
var _ = require('lodash');
var util = require('util');
var Uuid = require('uuid');
var sjcl = require('sjcl');

var Address = require('./address');
var AddressManager = require('./addressmanager');
var Bitcore = require('bitcore-lib');

var Common = require('../common');
var Constants = Common.Constants,
  Defaults = Common.Defaults,
  Utils = Common.Utils;

function Copayer() { };

Copayer._xPubToCopayerId = function (coin, xpub) {
  var id = crypto.createHash("sha256").update(xpub, "utf8").digest("base64");
  return id;
};

Copayer.create = function (opts) {
  opts = opts || {};
  $.checkArgument(opts.xPubKey, 'Missing copayer extended public key')
    .checkArgument(opts.requestPubKey, 'Missing copayer request public key')
    .checkArgument(opts.signature, 'Missing copayer request public key signature');

  $.checkArgument(Utils.checkValueInCollection(opts.coin, Constants.COINS));

  var x = new Copayer();

  x.version = 1;
  x.createdOn = Math.floor(Date.now() / 1000);
  x.coin = opts.coin;
  x.xPubKey = opts.xPubKey;
  x.account = opts.account || 0;
  x.deviceId = opts.deviceId;
  x.id = Copayer._xPubToCopayerId(opts.coin, x.xPubKey);
  x.name = opts.name;
  x.requestPubKey = opts.requestPubKey;
  x.signature = opts.signature;
  x.requestPubKeys = [{
    key: opts.requestPubKey,
    signature: opts.signature,
  }];

  var derivationStrategy = opts.derivationStrategy || Constants.DERIVATION_STRATEGIES.BIP44;
  if (AddressManager.supportsCopayerBranches(derivationStrategy)) {
    x.addressManager = AddressManager.create({
      derivationStrategy: derivationStrategy,
      copayerIndex: opts.copayerIndex,
    });
  }

  x.customData = opts.customData;

  return x;
};

Copayer.fromObj = function (obj) {
  var x = new Copayer();

  x.version = obj.version;
  x.createdOn = obj.createdOn;
  x.coin = obj.coin || Defaults.COIN;
  x.id = obj.id;
  x.name = obj.name;
  x.xPubKey = obj.xPubKey;
  x.deviceId = obj.deviceId;
  x.requestPubKey = obj.requestPubKey;
  x.signature = obj.signature;
  x.requestPubKeys = obj.requestPubKeys;

  if (obj.addressManager) {
    x.addressManager = AddressManager.fromObj(obj.addressManager);
  }
  x.customData = obj.customData;

  return x;
};

Copayer.prototype.createAddress = function (wallet, isChange) {
  $.checkState(wallet.isComplete());

  var path = this.addressManager.getNewAddressPath(isChange);
  var addressType = wallet.n > 1 ? Constants.ADDRESS_TYPES.SHARED : Constants.ADDRESS_TYPES.NORMAL;
  var address = Address.derive(wallet.id, wallet.definitionTemplate, wallet.copayers, path, addressType, isChange);
  return address;
};


module.exports = Copayer;
