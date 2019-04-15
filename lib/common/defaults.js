'use strict';

var Defaults = {};

Defaults.MAX_KEYS = 100;

// Time after which a tx proposal can be erased by any copayer. in seconds
Defaults.DELETE_LOCKTIME = 600;

// Allowed consecutive txp rejections before backoff is applied.
Defaults.BACKOFF_OFFSET = 10;

// Time a copayer need to wait to create a new tx after her previous proposal was rejected. in seconds.
Defaults.BACKOFF_TIME = 600;

Defaults.MAX_MAIN_ADDRESS_GAP = 20;

// TODO: should allow different gap sizes for external/internal chains
Defaults.SCAN_ADDRESS_GAP = Defaults.MAX_MAIN_ADDRESS_GAP + 10;

Defaults.FIAT_RATE_PROVIDER = 'Bittrex';
Defaults.FIAT_RATE_FETCH_INTERVAL = 10; // In minutes
Defaults.FIAT_RATE_MAX_LOOK_BACK_TIME = 120; // In minutes

Defaults.HISTORY_LIMIT = 2000;

// Number of confirmations from which tx in history will be cached
// (ie we consider them inmutables)
Defaults.CONFIRMATIONS_TO_START_CACHING = 6 * 6; // ~ 6hrs

// Number of addresses from which tx history is enabled in a wallet
Defaults.HISTORY_CACHE_ADDRESS_THRESOLD = 100;

// Number of addresses from which balance in cache for a few seconds
Defaults.BALANCE_CACHE_ADDRESS_THRESOLD = Defaults.HISTORY_CACHE_ADDRESS_THRESOLD;

Defaults.BALANCE_CACHE_DURATION = 10;

// Max allowed timespan for notification queries in seconds
Defaults.MAX_NOTIFICATIONS_TIMESPAN = 60 * 60 * 24 * 14; // ~ 2 weeks
Defaults.NOTIFICATIONS_TIMESPAN = 60;

Defaults.SESSION_EXPIRATION = 1 * 60 * 60; // 1 hour to session expiration

Defaults.RateLimit = {
  createWallet: {
    windowMs: 60 * 60 * 1000, // hour window
    delayAfter: 8, // begin slowing down responses after the 3rd request
    delayMs: 3000, // slow down subsequent responses by 3 seconds per request
    max: 15, // start blocking after 20 request
    message: 'Too many wallets created from this IP, please try again after an hour',
  },

  // otherPosts: {
  //   windowMs: 60 * 60 * 1000, // 1 hour window
  //   max: 1200 , // 1 post every 3 sec average, max.
  // },
};

Defaults.COIN = 'obyte';
Defaults.NETWORK = 'livenet';
Defaults.ADDRESS_TYPE = 'normal'
Defaults.ADDRESS_SYNC_BATCH_SIZE = 500000;

Defaults.LOCK_WAIT_TIME =    5 * 1000; // wait time 5s
Defaults.LOCK_EXE_TIME =     40 * 1000; // max lock time 50s
Defaults.SERVER_EXE_TIME = Defaults.LOCK_EXE_TIME * 1.5;


module.exports = Defaults;
