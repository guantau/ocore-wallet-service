
module.exports = function(wallet, appName, appVersion) {
  if (!appVersion || !appName) return;

  if (wallet.network == 'livenet' && appVersion.major==5 && wallet.createdOn < 1443461026 ) {
    return {
      title: 'Test message',
      body: 'Only for wallets',
      link: 'https://123cb.net',
      id: 'ocore1',
      dismissible: true,
      category: 'critical',
      app: 'ocore',
    };
  }
};
