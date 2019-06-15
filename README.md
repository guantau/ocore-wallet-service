
# Ocore-Wallet-Service (OWS)

A Multisig HD OByte Light Wallet Service.

# Description

OWS facilitates multisig HD wallets creation and operation through a simple and intuitive REST API.

OWS can usually be installed within minutes and accommodates all the needed infrastructure for peers in a multisig wallet to communicate and operate – with minimum server trust.
  
See [ocore-wallet-client](https://github.com/guantau/ocore-wallet-client) for the *official* client library that communicates to OWS and verifies its response. Also check [ocore-wallet](https://github.com/guantau/ocore-wallet) for a simple CLI wallet implementation that relies on OWS.

# Getting Started
```
 git clone https://github.com/guantau/ocore-wallet-service.git
 cd ocore-wallet-service
 npm install
 npm start
```

This will launch the OWS service (with default settings) at `http://localhost:3232/ows/api`.

OWS needs mongoDB. You can configure the connection at `config.js`

OWS supports SSL and Clustering. For a detailed guide on installing OWS with extra features see [Installing OWS](https://github.com/guantau/ocore-wallet-service/blob/master/installation.md). 

OWS uses by default a Request Rate Limitation to CreateWallet endpoint. If you need to modify it, check defaults.js' `Defaults.RateLimit`

# Using OWS with PM2

OWS can be used with PM2 with the provided `app.js` script: 
 
```
  pm2 start app.js --name "ocore-wallet-service"
```

# Security Considerations
 * Private keys are never sent to OWS. Copayers store them locally.
 * Extended public keys are stored on OWS. This allows OWS to easily check wallet balance, send offline notifications to copayers, etc.
 * During wallet creation, the initial copayer creates a wallet secret that contains a private key. All copayers need to prove they have the secret by signing their information with this private key when joining the wallet. The secret should be shared using secured channels.
 * A copayer could join the wallet more than once, and there is no mechanism to prevent this. See [wallet](https://github.com/guantau/ocore-wallet)'s confirm command, for a method for confirming copayers.
 * All OWS responses are verified:
  * Addresses and change addresses are derived independently and locally by the copayers from their local data.
  * TX Proposals templates are signed by copayers and verified by others, so the OWS cannot create or tamper with them.

# Using SSL

  You can add your certificates at the config.js using:

``` json
   https: true,
   privateKeyFile: 'private.pem',
   certificateFile: 'cert.pem',
  ////// The following is only for certs which are not
  ////// trusted by nodejs 'https' by default
  ////// CAs like Verisign do not require this
  // CAinter1: '', // ex. 'COMODORSADomainValidationSecureServerCA.crt'
  // CAinter2: '', // ex. 'COMODORSAAddTrustCA.crt'
  // CAroot: '', // ex. 'AddTrustExternalCARoot.crt'
```

# TX proposal life cycle

Tx proposal need to be:
 1. First created via /v?/txproposal
      -> This will create a 'temporary' TX proposal, returning the object, but not locking the inputs
 2. Then published via  /v?/txproposal/:id/publish
      -> This publish the tx proposal to all copayers, looking the inputs. The TX proposal can be `deleted` also, after been published.
 3. Then signed via /v?/txproposal/:id/signature for each copayer
 4. Then broadcasted to the p2p network via /v?/txproposal/:id/broadcast

The are plenty example creating and sending proposals in the `/test/integration` code.


# REST API

## Authentication

  In order to access a wallet, clients are required to send the headers:
```
  x-identity
  x-signature
```
Identity is the Peer-ID, this will identify the peer and its wallet. Signature is the current request signature, using `requestSigningKey`, the `m/1/1` derivative of the Extended Private Key.

See [Ocore Wallet Client](https://github.com/guantau/ocore-wallet-client/blob/master/lib/api.js) for implementation details.


## GET Endpoints

`/v1/wallets/`: Get wallet information

Returns:
 * Wallet object. (see [fields on the source code](https://github.com/guantau/ocore-wallet-service/blob/master/lib/model/wallet.js)).


`/v1/txhistory/`: Get Wallet's transaction history

Optional Arguments:
 * asset: Asset unit (defaults to null) 
 * addresses: Addresses to be queried separated by ,
 * skip: Records to skip from the result (defaults to 0)
 * limit: Total number of records to return (return all available records if not specified)
 * includeExtendedInfo: Whether include extended information (defaults to 1).
 
Returns:
 * History of incoming and outgoing transactions of the wallet. The list is paginated using the `skip` & `limit` params. Each item has the following fields:
 * action ('sent', 'received', 'moved')
 * amount
 * fee
 * unit
 * time
 * level
 * mci
 * asset
 * addressTo ('sent')
 * my_address ('received')
 * arrPayerAddresses ('received')
 * confirmations
 * proposalId
 * creatorName
 * message
 * actions array ['createdOn', 'type', 'copayerId', 'copayerName', 'comment']
  
 
`/v1/txproposals/`:  Get Wallet's pending transaction proposals and their status

Returns:
 * List of pending TX Proposals. (see [fields on the source code](https://github.com/guantau/ocore-wallet-service/blob/master/lib/model/txproposal.js))


`/v1/addresses/`: Get Wallet's main addresses (does not include change addresses)

Optional Arguments:
 * ignoreMaxGap: [false] Ignore checking less that 20 unused addresses (BIP44 GAP)

Returns:
 * List of Addresses object: (https://github.com/guantau/ocore-wallet-service/lib/model/address.js)).  This call is mainly provided so the client check this addresses for incoming transactions


`/v1/balance/`:  Get Wallet's balance

Returns:
 * totalAmount: Wallet's total balance
 * lockedAmount: Current balance of outstanding transaction proposals, that cannot be used on new transactions.
 * availableAmount: Funds available for new proposals.
 * totalConfirmedAmount: Same as totalAmount for confirmed UTXOs only.
 * lockedConfirmedAmount: Same as lockedAmount for confirmed UTXOs only.
 * availableConfirmedAmount: Same as availableAmount for confirmed UTXOs only.
 * byAddress array ['address', 'path', 'amount']: A list of addresses holding funds.
 * totalKbToSendMax: An estimation of the number of KiB required to include all available UTXOs in a tx (including unconfirmed).


`/v1/txnotes/:txid`:  Get user notes associated to the specified transaction.

Returns:
 * The note associated to the `txid` as a string.


`/v1/fiatrates/:code`:  Get the fiat rate.

Optional Arguments:
 * provider: An identifier representing the source of the rates.
 * ts: The timestamp for the fiat rate (defaults to now).

Returns:
 * The fiat exchange rate.
 

## POST Endpoints

`/v1/wallets/`: Create a new Wallet

 Required Arguments:
 * name: Name of the wallet 
 * m: Number of required peers to sign transactions 
 * n: Number of total peers on the wallet
 * pubKey: Wallet Creation Public key to check joining copayer's signatures (the private key is unknown by OWS and must be communicated by the creator peer to other peers).

Returns: 
 * walletId: Id of the new created wallet


`/v1/wallets/:id/copayers/`: Join a Wallet in creation

Required Arguments:
 * walletId: Id of the wallet to join
 * name: Copayer Name
 * xPubKey - Extended Public Key for this copayer.
 * requestPubKey - Public Key used to check requests from this copayer.
 * copayerSignature - Signature used by other copayers to verify that the copayer joining knows the wallet secret.

Returns:
 * copayerId: Assigned ID of the copayer (to be used on x-identity header)
 * wallet: Object with wallet's information


`/v1/txproposals/`: Add a new temporary transaction proposal

Required Arguments:
 * outputs: List of outputs (including address and amount).

Optional Arguments:
 * asset: Asset unit (defaults to 'base').
 * txProposalId: TX proposal ID if provided.
 * message: Encrypted private message to peers.
 * changeAddress: Change address for this TX.
 * sendAll: Send maximum amount of funds, only for bytes (defaults to false).
 * spendUnconfirmed: Spend unconfirmed units (defaults to false).
 * inputs: Inputs for this TX.

Returns:
 * TX Proposal object. (see [fields on the source code](https://github.com/guantau/ocore-wallet-service/blob/master/lib/model/txproposal.js)). `.id` is probably needed in this case.


`/v1/txproposals/:id/publish`: Publish the previously created `temporary` tx proposal.

Returns:
 * TX Proposal object. (see [fields on the source code](https://github.com/guantau/ocore-wallet-service/blob/master/lib/model/txproposal.js)).


`/v1/addresses/`: Request a new main address from wallet . (creates an address on normal conditions)

Returns:
 * Address object: (https://github.com/guantau/ocore-wallet-service/blob/master/lib/model/address.js)). Note that `path` is returned so client can derive the address independently and check server's response.


`/v1/txproposals/:id/signatures/`: Sign a transaction proposal

Required Arguments:
 * signatures:  All Transaction's input signatures, in order of appearance.
  
Returns:
 * TX Proposal object. (see [fields on the source code](https://github.com/guantau/ocore-wallet-service/blob/master/lib/model/txproposal.js)). `.status` is probably needed in this case.
  

`/v1/txproposals/:id/broadcast/`: Broadcast a transaction proposal
 
Returns:
 * TX Proposal object. (see [fields on the source code](https://github.com/guantau/ocore-wallet-service/blob/master/lib/model/txproposal.js)). `.status` is probably needed in this case.
  

`/v1/txproposals/:id/rejections`: Reject a transaction proposal
 
Returns:
 * TX Proposal object. (see [fields on the source code](https://github.com/guantau/ocore-wallet-service/blob/master/lib/model/txproposal.js)). `.status` is probably needed in this case.


`/v1/addresses/scan`: Start an address scan process looking for activity.

 Optional Arguments:
 * includeCopayerBranches: Scan all copayer branches following BIP45 recommendation (defaults to false). 


`/v1/txconfirmations/`: Subscribe to receive push notifications when the specified transaction gets confirmed.
Required Arguments:
 * txid:  The transaction to subscribe to.


## PUT Endpoints

`/v1/txnotes/:txid/`: Modify a note for a tx.


## DELETE Endpoints

`/v1/txproposals/:id/`: Deletes a transaction proposal. Only the creator can delete a TX Proposal, and only if it has no other signatures or rejections

 Returns:
 * TX Proposal object. (see [fields on the source code](https://github.com/guantau/ocore-wallet-service/blob/master/lib/model/txproposal.js)). `.id` is probably needed in this case.


`/v1/txconfirmations/:txid`: Unsubscribe from transaction `txid` and no longer listen to its confirmation.

   
# Push Notifications
  Recomended to complete config.js file:
  
  * [GCM documentation to get your API key](https://developers.google.com/cloud-messaging/gcm)
  * [Apple's Notification guide to know how to get your certificates for APN](https://developer.apple.com/library/ios/documentation/NetworkingInternet/Conceptual/RemoteNotificationsPG/Chapters/Introduction.html)


## POST Endpoints
`/v1/pushnotifications/subscriptions/`: Adds subscriptions for push notifications service at database.


## DELETE Endpoints
`/v2/pushnotifications/subscriptions/`: Remove subscriptions for push notifications service from database.

 



