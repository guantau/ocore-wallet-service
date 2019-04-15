'use strict';

var _ = require('lodash');

function TxProposalAction() {};

TxProposalAction.create = function(opts) {
  opts = opts || {};

  var x = new TxProposalAction();

  x.version = 1;
  x.createdOn = Math.floor(Date.now() / 1000);
  x.copayerId = opts.copayerId;
  // x.address = opts.address;
  x.type = opts.type;
  x.signatures = JSON.stringify(opts.signatures);
  x.xpub = opts.xpub;
  x.comment = opts.comment;

  return x;
};

TxProposalAction.fromObj = function(obj) {
  var x = new TxProposalAction();

  x.version = obj.version;
  x.createdOn = obj.createdOn;
  x.copayerId = obj.copayerId;
  // x.address = obj.address;
  x.type = obj.type;
  x.signatures = JSON.parse(obj.signatures);
  x.xpub = obj.xpub;
  x.comment = obj.comment;

  return x;
};

TxProposalAction.prototype.toObject = function () {
  var x = _.cloneDeep(this);
  x.signatures = JSON.stringify(this.signatures);
  return x;
};

module.exports = TxProposalAction;
