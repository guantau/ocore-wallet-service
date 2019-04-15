'use strict';

var $ = require('preconditions').singleton();
var crypto = require('crypto');
var _ = require('lodash');
var util = require('util');
var Uuid = require('uuid');
var sjcl = require('sjcl');

var ObjectHash = require('ocore/object_hash');

var Address = require('./address');
var AccountManager = require('./accountmanager');
var Bitcore = require('bitcore-lib');

var Common = require('../common');
var Constants = Common.Constants,
  Defaults = Common.Defaults,
  Utils = Common.Utils;

function Device() { };

Device._pubToDeviceId = function (pubKey) {
  var id = '0' + ObjectHash.getChash160(pubKey);
  return id;
};

Device.create = function (opts) {
  opts = opts || {};
  $.checkArgument(opts.pubKey, 'Missing public key');

  var x = new Device();

  x.version = 1;
  x.createdOn = Math.floor(Date.now() / 1000);
  x.pubKey = opts.pubKey;
  x.hub = opts.hub;
  x.pairingSecret = opts.pairingSecret;
  x.id = Device._pubToDeviceId(x.pubKey);
  x.name = opts.name;
  x.derivationStrategy = opts.derivationStrategy || Constants.DERIVATION_STRATEGIES.BIP44;
  x.accountManager = AccountManager.create({
    derivationStrategy: x.derivationStrategy,
  });
  x.scanStatus = null;
  x.coin = opts.coin || Defaults.COIN;
  x.network = opts.network || 'livenet';

  return x;
};

Device.fromObj = function (obj) {
  var x = new Device();

  x.version = obj.version;
  x.createdOn = obj.createdOn;
  x.pubKey = obj.pubKey;
  x.hub = obj.hub;
  x.pairingSecret = obj.pairingSecret;
  x.id = obj.id;
  x.name = obj.name;
  x.derivationStrategy = obj.derivationStrategy;
  if (obj.accountManager) {
    x.accountManager = AccountManager.fromObj(obj.accountManager);
  }
  x.scanStatus = obj.scanStatus;
  x.coin = obj.coin || Defaults.COIN;
  x.network = obj.network;
  if (!x.network) {
    x.network = obj.isTestnet ? 'testnet' : 'livenet';
  }

  return x;
};

Device.prototype.createAccount = function () {
  var path = this.accountManager.getNewAccountPath();
  return path;
};


module.exports = Device;
