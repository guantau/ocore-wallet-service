/*jslint node: true */
"use strict";

var config = require('../config');
var BlockchainMonitor = require('../lib/blockchainmonitor');

var bcm = new BlockchainMonitor();
bcm.start(config, function(err) {
  if (err) throw err;

  console.log('Blockchain monitor started');
});
