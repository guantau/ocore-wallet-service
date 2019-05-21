'use strict';

var $ = require('preconditions').singleton();

var Common = require('../common');
var Constants = Common.Constants,
  Defaults = Common.Defaults,
  Utils = Common.Utils;

function Asset() { };


Asset.create = function (opts) {
  opts = opts || {};
  $.checkArgument(opts.asset, 'Missing asset');
  $.checkArgument(opts.name, 'Missing name');

  var x = new Asset();
  x.asset = opts.asset;
  x.name = opts.name;
  x.shortName = opts.shortName;
  x.ticker = opts.ticker;
  x.issuer = opts.issuer;
  x.decimals = opts.decimals;
  x.description = opts.description;
  x.suffix = opts.suffix;
  x.registryAddress = opts.registryAddress;
  x.metadataUnit = opts.metadataUnit;
  x.cap = opts.cap;
  x.private = opts.private;
  x.transferrable = opts.transferrable;
  x.autoDestroy = opts.autoDestroy;
  x.fixedDenominations = opts.fixedDenominations;
  x.issuedByDefinerOnly = opts.issuedByDefinerOnly;
  x.cosignedByDefiner = opts.cosignedByDefiner;
  x.spenderAttested = opts.spenderAttested;
  x.issueCondition = opts.issueCondition;
  x.transferCondition = opts.transferCondition;
  x.createdOn = Math.floor(Date.now() / 1000);
  x.coin = opts.coin || Defaults.COIN;
  x.network = opts.network || 'livenet';

  return x;
};

Asset.fromObj = function (obj) {
  $.checkArgument(obj.asset, 'Missing asset');
  $.checkArgument(obj.name, 'Missing name');

  var x = new Asset();
  x.asset = obj.asset;
  x.name = obj.name;
  x.shortName = obj.shortName;
  x.ticker = obj.ticker;
  x.issuer = obj.issuer;
  x.decimals = obj.decimals;
  x.description = obj.description;
  x.suffix = obj.suffix;
  x.registryAddress = obj.registryAddress;
  x.metadataUnit = obj.metadataUnit;
  x.cap = obj.cap;
  x.private = obj.private;
  x.transferrable = obj.transferrable;
  x.autoDestroy = obj.autoDestroy;
  x.fixedDenominations = obj.fixedDenominations;
  x.issuedByDefinerOnly = obj.issuedByDefinerOnly;
  x.cosignedByDefiner = obj.cosignedByDefiner;
  x.spenderAttested = obj.spenderAttested;
  x.issueCondition = obj.issueCondition;
  x.transferCondition = obj.transferCondition;
  x.createdOn = Math.floor(Date.now() / 1000);
  x.coin = obj.coin || Defaults.COIN;
  x.network = obj.network || 'livenet';

  return x;
};

module.exports = Asset;
