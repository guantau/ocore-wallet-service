
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
 * wallet: Wallet object. (see [fields on the source code](https://github.com/guantau/ocore-wallet-service/blob/master/lib/model/wallet.js)).
 * balance: Balance object.
 * pendingTxps: Pending tx proposals.
 * preferences: User preferences.


`/v1/wallets/:identifier`: Get wallet information identified by identifier.

Required Arguments:
 * identifier: The identifier associated with the wallet (one of: walletId, address, txid)

Returns:
 * wallet: Wallet object. (see [fields on the source code](https://github.com/guantau/ocore-wallet-service/blob/master/lib/model/wallet.js)).
 * balance: Balance object.
 * pendingTxps: Pending tx proposals.
 * preferences: User preferences.


`/v1/copayers/`: Get all copayers with the same device id

Required Arguments:
 * deviceId: The device id.

Returns:
 * List of Copayers object: (see [fields on the source code](https://github.com/guantau/ocore-wallet-service/lib/model/copayer.js))


`/v1/addresses/`: Get Wallet's main addresses (does not include change addresses)

Optional Arguments:
 * limit: Limit the result set. Return all addresses by default.
 * reverse: Reverse the order of returned addresses. (defaults to false).

Returns:
 * List of Addresses object: (see [fields on the source code](https://github.com/guantau/ocore-wallet-service/lib/model/address.js)).


`/v1/balance/`:  Get Wallet's balance

Optional Arguments:
 * addresses: Addresses to be queried separated by ','.
 * asset: Asset unit hash. (defaults to query all assets)

Returns:
 * Balance Objects: The key is the asset unit hash, and 'base' is used for bytes. The object contains
   - stable: The amount reaches stable.
   - pending: The amount is pending.
   - stable_outputs_count: The count of outputs for stable amount.
   - pending_outputs_count: The count of outputs for pending amount.
   - decimals: The decimals of the asset.
   - ticker: The ticker of the asset, 'BYTES' is used for bytes. 


`/v1/txhistory/`: Get Wallet's transaction history

Required Arguments:
 * asset: Asset unit hash. (defaults to 'base') 

Optional Arguments:
 * addresses: Addresses to be queried separated by ','.
 * limit: Total number of records to return (return the first 10 records if not specified)
 * lastRowId: Retrieve transactions from this row id.
 
Returns:
 * History of incoming and outgoing transactions of the wallet. The list is paginated using the `lastRowId` & `limit` params. Each item has the following fields:
    - action ('sent', 'received', 'moved')
    - amount
    - payers: List of payers.
    - payees: List of payees.
    - stable
    - unit
    - fee
    - time
    - level
    - mci
    - asset
    - rowid
    - decimals
    - ticker
    - createdOn
    - proposalId
    - creatorName
    - message
    - actions array ['createdOn', 'type', 'copayerId', 'copayerName', 'comment']
    - customData
    - encryptedMessage
  
 
`/v1/txproposals/`:  Get Wallet's transaction proposals and their status

Optional Arguments:
 * minTs: (defaults to 0)
 * maxTs: (defaults to now)
 * limit: (defaults to all)
 * status: Among 'temporary', 'pending', 'accepted', 'broadcasted', 'rejected'.
 * app: (defaults to all)
 * isPending: (defaults to false)

Returns:
 * List of pending TX Proposals. (see [fields on the source code](https://github.com/guantau/ocore-wallet-service/blob/master/lib/model/txproposal.js))

 
`/v1/txproposals/pending`:  Get Wallet's pending transaction proposals and their status

Returns:
 * List of pending TX Proposals. (see [fields on the source code](https://github.com/guantau/ocore-wallet-service/blob/master/lib/model/txproposal.js))


`/v1/txproposals/:id`:  Get Wallet's transaction with id

Returns:
 * TX Proposals. (see [fields on the source code](https://github.com/guantau/ocore-wallet-service/blob/master/lib/model/txproposal.js))


`/v1/notifications`: Get wallet's notifications

Optional Arguments:
 * timeSpan: Time span from now. (defaults to ~2weeks)
 * notificationId: Query after this last known notification id.

Returns:
 * List of notifications. (see [fields on the source code](https://github.com/guantau/ocore-wallet-service/blob/master/lib/model/notification.js))


`/v1/txraw/:txid`: Get raw unit of txid

Returns:
 * Raw unit.

`/v1/utxos`: Get wallet's UTXOs

Optional Arguments:
 * addresses: Addresses to be queried separated by ','.
 * asset: Asset unit hash. (defaults to query all assets)

Returns:
 * List of UTXOs. Each item has the following fields:
    - unit
    - message_index
    - output_index
    - address
    - amount
    - asset
    - denomination
    - stable
    - time
    - path
    - definition


`/v1/assets/`: Get all available assets metadata.

Returns:
 * List of Assets. (see [fields on the source code](https://github.com/guantau/ocore-wallet-service/blob/master/lib/model/asset.js))

 
`/v1/assets/:asset`: Get metadata of asset.

Returns:
 * Asset Object. (see [fields on the source code](https://github.com/guantau/ocore-wallet-service/blob/master/lib/model/asset.js))


`/v1/txnotes/:txid`:  Get user notes associated to the specified transaction.

Returns:
 * The note associated to the `txid` as a string.


`/v1/fiatrates/:code`:  Get the fiat rate of `code`, such as 'BTC-GBYTE' or 'USDT-GBYTE'.

Optional Arguments:
 * provider: An identifier representing the source of the rates. (defaults 'Bittrex')
 * ts: The timestamp for the fiat rate. (defaults to now)

Returns:
 * The fiat exchange rate.

`/v1/preferences`: Get the preferences of this copayer.

Returns:
 * Preference Object: (see [fields on the source code](https://github.com/guantau/ocore-wallet-service/blob/master/lib/model/preferences.js))


## POST Endpoints

`/v1/wallets/`: Create a new Wallet

Required Arguments:
 * name: Name of the wallet.
 * m: Number of required peers to sign transactions. 
 * n: Number of total peers on the wallet.
 * pubKey: Wallet Creation Public key to check joining copayer's signatures. (the private key is unknown by OWS and must be communicated by the creator peer to other peers)

Optional Arguments:
 * id: Id of the wallet.
 * singleAddress: The wallet will only have one address. (defaults to true)
 * coin: The coin for this wallet. (defaults to 'obyte')
 * network: The network for this wallet. (defaults to 'livenet')
 * supportBIP44: Client supports BIP44 for new wallets. (defaults to true)

Returns: 
 * walletId: Id of the new created wallet.


`/v1/wallets/:id/copayers/`: Join a Wallet in creation

Required Arguments:
 * walletId: Id of the wallet to join.
 * deviceId: Id of the copayer's device.
 * account: Account index of the copayer in his device.
 * name: Copayer Name.
 * xPubKey: Extended Public Key for this copayer.
 * requestPubKey: Public Key used to check requests from this copayer.
 * copayerSignature: Signature used by other copayers to verify that the copayer joining knows the wallet secret.

Optional Arguments:
 * coin: The coin for this wallet. (defaults to 'obyte')
 * customData: Custom data for this copayer.
 * dryRun: Simulate the action but do not change server state. (defaults to false)
 * supportBIP44: Client supports BIP44 for joining wallets. (defaults to true)

Returns:
 * copayerId: Assigned ID of the copayer (to be used on x-identity header)
 * wallet: Object with wallet's information


`/v1/txproposals/`: Add a new temporary transaction proposal

Required Arguments:
 * app: Transaction proposal type. (defaults to 'payment', others include 'text', 'data', 'data feed', 'profile', 'poll', 'vote', etc.)
 * params: Params for app.

 * app: payment
    - params.asset: Hash of unit where the asset was defined. (defaults to null).
    - params.outputs: List of outputs.
    - params.outputs[].address: Destination address.
    - params.outputs[].amount: Amount to transfer.
    - params.inputs: Inputs for this TX
    - params.change_address: Use this address as the change address for the tx. The address should belong to the wallet. In the case of singleAddress wallets, the first main address will be used.
    - params.send_all: Send maximum amount of bytes. (defaults to false).
    - params.spend_unconfirmed: UTXOs of unconfirmed transactions as inputs. (defaults to 'own', others include 'all', 'none')
    - payload: Extra messages to sent.

 * app: data - One can store arbitrary structured data using 'data' message type.
    - params: Structured data of key-value  
 
 * app: text - One can store arbitrary texts using 'text' message type.
    - params: Text to store.

 * app: profile - Users can store their profiles on Obyte if they want.
    - params: Profile data of key-value.
 
 * app: poll - Anyone can set up a poll by sending a message with app='poll'.
    - params.questions: Question of the poll.
    - params.choices: Allowed set of choices.

 * app: vote - To cast votes, users send 'vote' messages.
    - params.unit: Hash of unit where the poll was defined.
    - params.choice: Indicate what the user want to vote for. The choice must be defined in the poll message.

 * app: data_feed - Data fields can be used to design definitions that involve oracles.
    - params: Data feed of key-value.

 * app: attestation - Attestations confirm that the user who issued the attestation (the attestor) verified some data about the attested user (the subject).
    - params.address: Address of the attested user (the subject).
    - params.profile: Verified data about the attested user.

 * app: asset - Assets in OByte can be issued, transferred, and exchanged, and.they behave similarly to the native currency 'bytes'.
    - params.cap: Is the total number of coins that can be issued (money supply). If omitted, the number is unlimited.
    - params.is_private: Indicates whether the asset is private (such as blackbytes) or publicly traceable (similar to bytes).
    - params.is_transferrable: Indicates whether the asset can be freely transferred among arbitrary parties or all transfers should involve the definer address as either sender or recipient. The latter can be useful e.g. for loyalty points that cannot be resold.
    - params.auto_destroy: Indicates whether the asset is destroyed when it is sent to the definer address.
    - params.fixed_denominations: Indicates whether the asset exists as coins (banknotes) of a limited set of denominations, similar to blackbytes. If it is true, the definition must also include property denominations, which is an array of all denominations and the number of coins of that denomination.
    - params.denominations: Optional. Array of all denominations and the number of coins of that denomination.
    - params.issued_by_definer_only: Indicates whether the asset can be issued only by the definer address. If false, anyone can issue the asset, in this case cap must be unlimited.
    - params.cosigned_by_definer: Indicates whether each operation with the asset must be cosigned by the definer address. Useful for regulated assets where the issuer (bank) wants to perform various compliance checks (such as the funds are not arrested by a court order) prior to approving a transaction.
    - params.spender_attested: Indicates whether the spender of the asset must be attested by one of approved attestors. Also useful for regulated assets e.g. to limit the access to the asset only to KYC'ed users. If true, the definition must also include the list of approved attestor addresses.
    - params.attestors: List of approved attestor addresses
    - params.issue_condition: Specify the restrictions when the asset can be issued. It evaluate to a boolean and are coded in the same smart contract language as address definitions.
    - params.transfer_condition: Specify the restrictions when the asset can be transferred. It evaluate to a boolean and are coded in the same smart contract language as address definitions.
  
 * app: asset_attestors - The list of an asset attestors can be amended by the definer by sending an 'asset_attestors' message that replaces the list of attestors.
    - params.asset: Asset unit id.
    - params.attestors: List of approved attestor addresses.

 * app: address definition change - Users can update definitions of their addresses while keeping the old address.
    - params.definition_chash: Indicates the checksummed hash of the new address definition.
    - params.address: When multi-authored, must indicate address.

 * app: definition_template - The template looks like normal definition but may include references to variables in the syntax @param1, @param2. Definition templates enable code reuse. They may in turn reference other templates.
    - params: Definition template.
 

Optional Arguments:
 * txProposalId: If provided it will be used as this TX proposal ID. Should be unique in the scope of the wallet.
 * message: A message to attach to this transaction.
 * dryRun: Simulate the action but do not change server state.
 * testRun: Add transaction proposal for test mode.
 * unit: Unit data for test mode.
 * signingInfo: Signing information for test mode.

Returns:
 * TX Proposal object. (see [fields on the source code](https://github.com/guantau/ocore-wallet-service/blob/master/lib/model/txproposal.js)). `.id` is probably needed in this case.


`/v1/txproposals/:id/publish`: Publish the previously created `temporary` tx proposal.

Returns:
 * TX Proposal object. (see [fields on the source code](https://github.com/guantau/ocore-wallet-service/blob/master/lib/model/txproposal.js)).


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


`/v1/addresses/`: Request a new main address from wallet. (creates an address on normal conditions)

Returns:
 * Address object: (https://github.com/guantau/ocore-wallet-service/blob/master/lib/model/address.js)). Note that `path` is returned so client can derive the address independently and check server's response.


`/v1/addresses/scan`: Start an address scan process looking for activity.

 Optional Arguments:
 * includeCopayerBranches: Scan all copayer branches following BIP45 recommendation (defaults to false). 


`/v1/txconfirmations/`: Subscribe to receive push notifications when the specified transaction gets confirmed.
Required Arguments:
 * txid:  The transaction to subscribe to.


## PUT Endpoints

`/v1/txnotes/:txid/`: Modify a note for a tx.

`/v1/preferences`: Modify preferences.

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

 



