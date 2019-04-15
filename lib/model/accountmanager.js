var _ = require('lodash');
var $ = require('preconditions').singleton();

var Constants = require('../common/constants');
var Utils = require('../common/utils');

function AccountManager() {};

AccountManager.create = function(opts) {
  opts = opts || {};

  var x = new AccountManager();

  x.version = 1;
  x.derivationStrategy = opts.derivationStrategy || Constants.DERIVATION_STRATEGIES.BIP44;
  $.checkState(Utils.checkValueInCollection(x.derivationStrategy, Constants.DERIVATION_STRATEGIES));
  x.account = 0;
  x.skippedPaths = [];

  return x;
};

AccountManager.fromObj = function(obj) {
  var x = new AccountManager();

  x.version = obj.version;
  x.derivationStrategy = obj.derivationStrategy || Constants.DERIVATION_STRATEGIES.BIP44;
  x.account = obj.account;
  x.skippedPaths = [];

  return x;
};

AccountManager.supportsCopayerBranches = function(derivationStrategy) {
  return derivationStrategy == Constants.DERIVATION_STRATEGIES.BIP45;
};

AccountManager.prototype._incrementIndex = function() {
  this.account++;
};

AccountManager.prototype.rewindIndex = function(step, n) {
  step = _.isUndefined(step) ? 1 : step;
  n = _.isUndefined(n) ? 1 : n;

  this.account = Math.max(0, this.account - n * step);
};

AccountManager.prototype.getCurrentIndex = function() {
  return this.account;
};

AccountManager.prototype.getBaseAccountPath = function() {
  if (this.derivationStrategy == Constants.DERIVATION_STRATEGIES.BIP44) {
    return "m/44'/0'";
  } else {
    return "m/45'";
  }
};

AccountManager.prototype.getCurrentAccountPath = function() {
  if (this.derivationStrategy == Constants.DERIVATION_STRATEGIES.BIP44) {
    return "m/44'/0'/" + this.account + "'";
  } else {
    return "m/45'/" + this.account;
  }
};

AccountManager.prototype.getNewAccountPath = function(step) {
  var ret;
  var i = 0;
  step = step || 1;

  while (i++ < step ) {
    if (ret) {
      this.skippedPaths.push({path:ret});
    }

    ret = this.getCurrentAccountPath();
    this._incrementIndex();
  }
  return ret;
};

AccountManager.prototype.getNextSkippedPath = function() {
  if (_.isEmpty(this.skippedPaths))
    return null;

  var ret = this.skippedPaths.pop();
  return ret;
};


module.exports = AccountManager;
