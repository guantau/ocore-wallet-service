const host = process.env.DB_HOST || 'localhost';
const port = process.env.DB_PORT || '27017';
var config = {
  mongoDb: {
    uri: `mongodb://${host}:${port}/ows_test`,
  },
};

module.exports = config;
