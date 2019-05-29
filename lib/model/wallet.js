'use strict';

var _ = require('lodash');
var util = require('util');
var log = require('npmlog');
var $ = require('preconditions').singleton();
var Uuid = require('uuid');

var Address = require('./address');
var Copayer = require('./copayer');
var AddressManager = require('./addressmanager');
var Bitcore = require('bitcore-lib');

var Common = require('../common');
var Constants = Common.Constants,
  Defaults = Common.Defaults,
  Utils = Common.Utils;

function Wallet() {};

Wallet.create = function(opts) {
  opts = opts || {};

  var x = new Wallet();

  $.shouldBeNumber(opts.m);
  $.shouldBeNumber(opts.n);
  $.checkArgument(opts.m > 0 && opts.m <= opts.n);
  $.checkArgument(Utils.checkValueInCollection(opts.coin, Constants.COINS));
  $.checkArgument(Utils.checkValueInCollection(opts.network, Constants.NETWORKS));

  x.version = 1;
  x.createdOn = Math.floor(Date.now() / 1000);
  x.id = opts.id || Uuid.v4();
  x.name = opts.name;
  x.m = opts.m;
  x.n = opts.n;
  x.singleAddress = !!opts.singleAddress;
  x.status = 'pending';
  x.copayers = [];
  x.publicKeyRing = [];
  x.pubKey = opts.pubKey;
  x.coin = opts.coin || Defaults.COIN;
  x.network = opts.network || 'livenet';
  x.derivationStrategy = opts.derivationStrategy || Constants.DERIVATION_STRATEGIES.BIP44;
  x.addressType = opts.n > 1 ? Constants.ADDRESS_TYPES.SHARED : Constants.ADDRESS_TYPES.NORMAL;

  x.addressManager = AddressManager.create({
    derivationStrategy: x.derivationStrategy,
  });
  x.scanStatus = null;

  if (x.n == 1) {
    x.definitionTemplate = [];
  } else {
    x.definitionTemplate = ["r of set",{"required":x.m,"set":[]}];
  }

  return x;
};

Wallet.fromObj = function(obj) {
  var x = new Wallet();

  $.shouldBeNumber(obj.m);
  $.shouldBeNumber(obj.n);
  $.checkArgument(obj.m > 0 && obj.m <= obj.n);

  x.version = obj.version;
  x.createdOn = obj.createdOn;
  x.id = obj.id;
  x.name = obj.name;
  x.m = obj.m;
  x.n = obj.n;
  x.singleAddress = !!obj.singleAddress;
  x.status = obj.status;
  x.publicKeyRing = obj.publicKeyRing;
  x.definitionTemplate = obj.definitionTemplate;
  x.copayers = _.map(obj.copayers, function(copayer) {
    return Copayer.fromObj(copayer);
  });
  x.pubKey = obj.pubKey;
  x.coin = obj.coin || Defaults.COIN;
  x.network = obj.network;
  if (!x.network) {
    x.network = obj.isTestnet ? 'testnet' : 'livenet';
  }
  x.derivationStrategy = obj.derivationStrategy || Constants.DERIVATION_STRATEGIES.BIP44;
  x.addressType = obj.n > 1 ? Constants.ADDRESS_TYPES.SHARED : Constants.ADDRESS_TYPES.NORMAL;
  x.addressManager = AddressManager.fromObj(obj.addressManager);
  x.scanStatus = obj.scanStatus;

  return x;
};

Wallet.prototype.toObject = function() {
  var x = _.cloneDeep(this);
  x.isShared = this.isShared();
  return x;
};

/**
 * Get the maximum allowed number of required copayers.
 * This is a limit imposed by the maximum allowed size of the scriptSig.
 * @param {number} totalCopayers - the total number of copayers
 * @return {number}
 */
Wallet.getMaxRequiredCopayers = function(totalCopayers) {
  return Wallet.COPAYER_PAIR_LIMITS[totalCopayers];
};

Wallet.verifyCopayerLimits = function(m, n) {
  return (n >= 1 && n <= 15) && (m >= 1 && m <= n);
};

Wallet.prototype.isShared = function() {
  return this.n > 1;
};

Wallet.prototype._updatePublicKeyRing = function() {
  this.publicKeyRing = _.map(this.copayers, function(copayer) {
    return _.pick(copayer, ['xPubKey', 'requestPubKey', 'deviceId', 'account']);
  });
};

Wallet.prototype.addCopayer = function(copayer) {
  $.checkState(copayer.coin == this.coin);

  this.copayers.push(copayer);

  if (this.n == 1) {
    this.definitionTemplate = ["sig",{"pubkey":"$pubkey@"+copayer.deviceId}];
  } else {
    this.definitionTemplate[1].set.push(["sig",{"pubkey":"$pubkey@"+copayer.deviceId}]);
  }

  if (this.copayers.length < this.n) return;

  this.status = 'complete';
  this._updatePublicKeyRing();
};

Wallet.prototype.addCopayerRequestKey = function(copayerId, requestPubKey, signature, restrictions, name) {
  $.checkState(this.copayers.length == this.n);

  var c = this.getCopayer(copayerId);

  //new ones go first
  c.requestPubKeys.unshift({
    key: requestPubKey.toString(),
    signature: signature,
    selfSigned: true,
    restrictions: restrictions || {},
    name: name || null,
  });
};

Wallet.prototype.getCopayer = function(copayerId) {
  return _.find(this.copayers, {
    id: copayerId
  });
};

Wallet.prototype.isComplete = function() {
  return this.status == 'complete';
};

Wallet.prototype.isScanning = function() {
  return this.scanning;
};

Wallet.prototype.createAddress = function(isChange, step) {
  $.checkState(this.isComplete());
  var self = this;

  var path = self.addressManager.getNewAddressPath(isChange, step);
  log.verbose('Deriving addr:' + path);
  var addressType = self.n > 1 ? Constants.ADDRESS_TYPES.SHARED : Constants.ADDRESS_TYPES.NORMAL;
  var address = Address.derive(self.id, self.definitionTemplate, self.copayers, path, addressType, isChange);  
  return address;
};

/// Only for power scan
Wallet.prototype.getSkippedAddress = function() {
  $.checkState(this.isComplete());
  var self = this;

  var addressType = self.n > 1 ? Constants.ADDRESS_TYPES.SHARED : Constants.ADDRESS_TYPES.NORMAL;
  var next = self.addressManager.getNextSkippedPath();
  if (!next) return;
  var address = Address.derive(self.id, self.definitionTemplate, self.copayers, next.path, addressType, next.isChange);
  return address;
};


module.exports = Wallet;
