var _ = require('lodash');

const symbols = ['USDT-BTC', 'BTC-GBYTE'];

var provider = {
  name: 'Bittrex',
  url: 'https://bittrex.com/api/v1.1/public/getmarketsummaries',
  parseFn: function(raw) {
    let arrCoinInfos = raw.result;
    let prices = {};
    let rates = [];
    arrCoinInfos.forEach(coinInfo => {
      if (!coinInfo.Last)
        return;
      if (symbols.includes(coinInfo.MarketName)) {
        prices[coinInfo.MarketName] = coinInfo.Last;
        rates.push({code: coinInfo.MarketName, value: coinInfo.Last});
        console.log("new exchange rate: " + coinInfo.MarketName + "=" + coinInfo.Last);
      }
    });
    if (Object.keys(prices).length == symbols.length) {
      rates.push({code: 'USDT-GBYTE', value: prices['BTC-GBYTE'] * prices['USDT-BTC']});
    }

    return rates;
  },
};

module.exports = provider;
