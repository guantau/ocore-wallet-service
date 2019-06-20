var _ = require('lodash');
var Uuid = require('uuid');

/*
 * messages shared between copayers
 */
function Message() {};

Message.create = function(opts) {
  opts = opts || {};

  var x = new Message();

  x.version = 1;
  var now = Date.now();

  x.createdOn = Math.floor(now / 1000);
  x.id = _.padStart(now, 14, '0') + _.padStart(opts.ticker || 0, 4, '0');
  x.type = opts.type || 'data';
  x.data = opts.data;
  x.fromWalletId = opts.fromWalletId;
  x.fromAddress = opts.fromAddress || null;
  x.fromPubKey = opts.fromPubKey;
  x.toWalletId = opts.toWalletId;
  x.toAddress = opts.toAddress || null;
  x.toPubKey = opts.toPubKey;

  return x;
};

Message.fromObj = function(obj) {
  var x = new Message();

  x.version = obj.version;
  x.createdOn = obj.createdOn;
  x.id = obj.id;
  x.type = obj.type,
  x.data = obj.data;
  x.fromWalletId = obj.fromWalletId;
  x.fromAddress = obj.fromAddress || null;
  x.fromPubKey = obj.fromPubKey;
  x.toWalletId = obj.toWalletId;
  x.toAddress = obj.toAddress || null;
  x.toPubKey = obj.toPubKey;

  return x;
};

module.exports = Message;
