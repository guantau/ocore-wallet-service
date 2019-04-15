'use strict';

var $ = require('preconditions').singleton();
var _ = require('lodash');

var ObjectHash = require('ocore/object_hash');
var Definition = require('ocore/definition');
var ValidationUtils = require('ocore/validation_utils');
var Bitcore = require('bitcore-lib');
var Common = require('../common');
var Constants = Common.Constants,
  Defaults = Common.Defaults,
  Utils = Common.Utils;

function Address() {};

Address.create = function(opts) {
  opts = opts || {};

  var x = new Address();

  x.coin = opts.coin || Defaults.COIN;
  $.checkArgument(Utils.checkValueInCollection(x.coin, Constants.COINS));

  x.version = 1;
  x.createdOn = Math.floor(Date.now() / 1000);
  x.address = opts.address;
  x.walletId = opts.walletId;
  x.definition = opts.definition;
  x.signingPath = opts.signingPath || {};
  x.isChange = opts.isChange || 0;
  x.path = opts.path || 'm/0/0';
  x.network = opts.network || Defaults.NETWORK;
  x.type = opts.type || Defaults.ADDRESS_TYPE;
  x.hasActivity = null;
  x.beRegistered = null;

  if (opts.definition) {
    x.address = ObjectHash.getChash160(opts.definition);    
    x.signingPath = Address._getSigningPath(opts.definition);
  }

  return x;
};

Address.fromObj = function(obj) {
  var x = new Address();

  x.version = obj.version;
  x.createdOn = obj.createdOn;
  x.address = obj.address;
  x.walletId = obj.walletId;
  x.definition = obj.definition;
  x.signingPath = obj.signingPath;
  x.coin = obj.coin || Defaults.COIN;
  x.network = obj.network || Defaults.NETWORK;
  x.isChange = obj.isChange || 0;
  x.path = obj.path || 'm/0/0';
  x.type = obj.type || Defaults.ADDRESS_TYPE;
  x.hasActivity = obj.hasActivity;
  x.beRegistered = obj.beRegistered;
  return x;
};

Address._getSigningPath = function(definition) {
	function evaluate(arr, path){
		var op = arr[0];
		var args = arr[1];
		if (!args)
			return;
		switch (op) {
			case 'sig':
				if (!args.pubkey)
					return;
				assocPubkeyBySigningPaths[args.pubkey] = path;
				break;
			case 'hash':
				if (!args.hash)
					return;
				assocPubkeyBySigningPaths[args.hash] = path;
				break;
			case 'or':
			case 'and':
				for (var i=0; i<args.length; i++)
					evaluate(args[i], path + '.' + i);
				break;
			case 'r of set':
				if (!ValidationUtils.isNonemptyArray(args.set))
					return;
				for (var i=0; i<args.set.length; i++)
					evaluate(args.set[i], path + '.' + i);
				break;
			case 'weighted and':
				if (!ValidationUtils.isNonemptyArray(args.set))
					return;
				for (var i=0; i<args.set.length; i++)
					evaluate(args.set[i].value, path + '.' + i);
				break;
      case 'address':
			case 'definition template':
				throw Error(op+" not supported yet");
		}
	}
	var assocPubkeyBySigningPaths = {};
	evaluate(definition, 'r');
	return assocPubkeyBySigningPaths;
}

Address._deriveAddress = function(definitionTemplate, copayers, path) {
  var params = {};
  copayers.forEach(function(item) {
    var xpub = new Bitcore.HDPublicKey(item.xPubKey);
    var pubkey = xpub.deriveChild(path).publicKey;
    params['pubkey@'+item.deviceId] = pubkey.toBuffer().toString('base64');
  })

  var definition = Definition.replaceInTemplate(definitionTemplate, params);
  var address = ObjectHash.getChash160(definition);
  var signingPath = Address._getSigningPath(definition);

  return {
    address: address,
    definition: definition
  };
};

Address.derive = function(walletId, definitionTemplate, copayers, path, addressType, isChange) {
  $.checkArgument(Utils.checkValueInCollection(addressType, Constants.ADDRESS_TYPES));

  var raw = Address._deriveAddress(definitionTemplate, copayers, path);
  return Address.create(_.extend(raw, {
    walletId: walletId,
    type: addressType,
    path: path,
    isChange: isChange,
  }));
};


module.exports = Address;
