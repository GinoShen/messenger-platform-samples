/*
 * Copyright 2016-present, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

/* jshint node: true, devel: true */
'use strict';

const
  bodyParser = require('body-parser'),
  config = require('config'),
  crypto = require('crypto'),
  express = require('express'),
  https = require('https'),
  request = require('request');

var app = express();
app.set('port', process.env.PORT || 80);
app.set('view engine', 'ejs');
app.use(bodyParser.json({ verify: verifyRequestSignature }));
app.use(express.static('public'));

/*
 * Be sure to setup your config values before running this code. You can
 * set them using environment variables or modifying the config file in /config.
 *
 */

// App Secret can be retrieved from the App Dashboard
const APP_SECRET = (process.env.MESSENGER_APP_SECRET) ?
  process.env.MESSENGER_APP_SECRET :
  config.get('appSecret');

// Arbitrary value used to validate a webhook
const VALIDATION_TOKEN = (process.env.MESSENGER_VALIDATION_TOKEN) ?
  (process.env.MESSENGER_VALIDATION_TOKEN) :
  config.get('validationToken');

// Generate a page access token for your page from the App Dashboard
const PAGE_ACCESS_TOKEN = (process.env.MESSENGER_PAGE_ACCESS_TOKEN) ?
  (process.env.MESSENGER_PAGE_ACCESS_TOKEN) :
  config.get('pageAccessToken');

// URL where the app is running (include protocol). Used to point to scripts and
// assets located at this address.
const SERVER_URL = (process.env.SERVER_URL) ?
  (process.env.SERVER_URL) :
  config.get('serverURL');

const EMQ_API_URL = (process.env.EMQ_API_URL) ?
  (process.env.EMQ_API_URL) :
  config.get('emqAPIURL');

const EMQ_WEB_SERVICE_URL = (process.env.EMQ_WEB_SERVICE_URL) ?
  (process.env.EMQ_WEB_SERVICE_URL) :
  config.get('emqWebServicURL');


if (!(APP_SECRET && VALIDATION_TOKEN && PAGE_ACCESS_TOKEN && SERVER_URL)) {
  console.error("Missing config values");
  process.exit(1);
}

/*
 * Use your own validation token. Check that the token used in the Webhook
 * setup is the same token used here.
 *
 */
app.get('/webhook', function(req, res) {
  if (req.query['hub.mode'] === 'subscribe' &&
      req.query['hub.verify_token'] === VALIDATION_TOKEN) {
    console.log("Validating webhook");
    res.status(200).send(req.query['hub.challenge']);
  } else {
    console.error("Failed validation. Make sure the validation tokens match.");
    res.sendStatus(403);
  }
});


/*
 * All callbacks for Messenger are POST-ed. They will be sent to the same
 * webhook. Be sure to subscribe your app to your page to receive callbacks
 * for your page.
 * https://developers.facebook.com/docs/messenger-platform/product-overview/setup#subscribe_app
 *
 */
 app.get('/setup',function(req,res){

     setupGetStartedButton(res);

 });

app.post('/webhook', function (req, res) {
  var data = req.body;
  console.log("hahahahaha webhook POST");
  // Make sure this is a page subscription
  if (data.object == 'page') {
    // Iterate over each entry
    // There may be multiple if batched
    data.entry.forEach(function(pageEntry) {
      var pageID = pageEntry.id;
      var timeOfEvent = pageEntry.time;

      // Iterate over each messaging event
      console.log("pageEntry.messaging: ", pageEntry.messaging);
      pageEntry.messaging.forEach(function(messagingEvent) {
        if (messagingEvent.optin) {
          receivedAuthentication(messagingEvent);
        } else if (messagingEvent.message) {
          receivedMessage(messagingEvent);
        } else if (messagingEvent.delivery) {
          receivedDeliveryConfirmation(messagingEvent);
        } else if (messagingEvent.postback) {
          receivedPostback(messagingEvent);
        } else if (messagingEvent.read) {
          receivedMessageRead(messagingEvent);
        } else if (messagingEvent.account_linking) {
          receivedAccountLink(messagingEvent);
        } else {
          console.log("Webhook received unknown messagingEvent: ", messagingEvent);
        }
      });
    });

    // Assume all went well.
    //
    // You must send back a 200, within 20 seconds, to let us know you've
    // successfully received the callback. Otherwise, the request will time out.
    res.sendStatus(200);
  }
});

/*
 * This path is used for account linking. The account linking call-to-action
 * (sendAccountLinking) is pointed to this URL.
 *
 */
app.get('/authorize', function(req, res) {
  var accountLinkingToken = req.query.account_linking_token;
  var redirectURI = req.query.redirect_uri;

  // Authorization Code should be generated per user by the developer. This will
  // be passed to the Account Linking callback.
  var authCode = "1234567890";

  // Redirect users to this URI on successful login
  var redirectURISuccess = redirectURI + "&authorization_code=" + authCode;

  res.render('authorize', {
    accountLinkingToken: accountLinkingToken,
    redirectURI: redirectURI,
    redirectURISuccess: redirectURISuccess
  });
});

app.get('/sendMessageFromCore', function(req, res) {
  console.log("Send Message from core");
  res.sendStatus(404);
});

app.post('/sendMessageFromCore', function (req, res) {
  var data = req.body;
  console.log(data);
  // Make sure this is a page subscription
  var type = data.type;
  var title = data.title;
  var message = data.message;
  var transferId = data.transfer?data.transfer.id:"";
  var transferRequestId = data.transfer_request?data.transfer_request.reference:"";
  var recipientId = data.messenger_id;
  if (recipientId == undefined || recipientId.length == 0) {
    console.log("no recipient id"+transferId)
    res.sendStatus(200);
    return;
  }

  if (transferId.length>0) {
    type = transaction_status_updated;
  }else if(transferRequestId.length>0){
    type = recipient_information_created;
  }

  switch (type) {
    case 'transaction_status_updated':
    sendTrasactionStatusUpdatedMessage(recipientId, title, message, transferId)
      break;

    case 'rate_change':
    sendRateChangedMessage(recipientId, title, message)
      break;

    case 'recipient_information_created':
    sendRecipientDataUpdatedMessage(recipientId, title, message, transferRequestId)
      break

    case 'customer-centric':
    if(title.length>0){
      sendTextMessage(recipientId, title+" "+message)
    }else{
      sendTextMessage(recipientId, title+message)
    }
      break

    default:
    if(title.length>0){
      sendTextMessage(recipientId, title+"\n"+message)
    }else{
      sendTextMessage(recipientId, title+message)
    }
      break
  }
  res.sendStatus(200);
});

/*
 * Verify that the callback came from Facebook. Using the App Secret from
 * the App Dashboard, we can verify the signature that is sent with each
 * callback in the x-hub-signature field, located in the header.
 *
 * https://developers.facebook.com/docs/graph-api/webhooks#setup
 *
 */
function verifyRequestSignature(req, res, buf) {
  var signature = req.headers["x-hub-signature"];
  if (!signature) {
    // For testing, let's log an error. In production, you should throw an
    // error.
    console.error("Couldn't validate the signature.");
  } else {
    var elements = signature.split('=');
    var method = elements[0];
    var signatureHash = elements[1];

    var expectedHash = crypto.createHmac('sha1', APP_SECRET)
                        .update(buf)
                        .digest('hex');

    if (signatureHash != expectedHash) {
      throw new Error("Couldn't validate the request signature.");
    }
  }
}

/*
 * Authorization Event
 *
 * The value for 'optin.ref' is defined in the entry point. For the "Send to
 * Messenger" plugin, it is the 'data-ref' field. Read more at
 * https://developers.facebook.com/docs/messenger-platform/webhook-reference/authentication
 *
 */
function receivedAuthentication(event) {
  var senderID = event.sender.id;
  var recipientID = event.recipient.id;
  var timeOfAuth = event.timestamp;

  // The 'ref' field is set in the 'Send to Messenger' plugin, in the 'data-ref'
  // The developer can set this to an arbitrary value to associate the
  // authentication callback with the 'Send to Messenger' click event. This is
  // a way to do account linking when the user clicks the 'Send to Messenger'
  // plugin.
  var passThroughParam = event.optin.ref;

  console.log("Received authentication for user %d and page %d with pass " +
    "through param '%s' at %d", senderID, recipientID, passThroughParam,
    timeOfAuth);

  // When an authentication is received, we'll send a message back to the sender
  // to let them know it was successful.
  sendTextMessage(senderID, "Authentication successful");
}

/*
 * Message Event
 *
 * This event is called when a message is sent to your page. The 'message'
 * object format can vary depending on the kind of message that was received.
 * Read more at https://developers.facebook.com/docs/messenger-platform/webhook-reference/message-received
 *
 * For this example, we're going to echo any text that we get. If we get some
 * special keywords ('button', 'generic', 'receipt'), then we'll send back
 * examples of those bubbles to illustrate the special message bubbles we've
 * created. If we receive a message with an attachment (image, video, audio),
 * then we'll simply confirm that we've received the attachment.
 *
 */
function receivedMessage(event) {
  var senderID = event.sender.id;
  var recipientID = event.recipient.id;
  var timeOfMessage = event.timestamp;
  var message = event.message;

  console.log("Received message for user %d and page %d at %d with message:",
    senderID, recipientID, timeOfMessage);
  console.log(JSON.stringify(message));

  var isEcho = message.is_echo;
  var messageId = message.mid;
  var appId = message.app_id;
  var metadata = message.metadata;

  // You may get a text or attachment but not both
  var messageText = message.text;
  var messageAttachments = message.attachments;
  var quickReply = message.quick_reply;

  if (isEcho) {
    // Just logging message echoes to console
    console.log("Received echo for message %s and app %d with metadata %s",
      messageId, appId, metadata);
    return;
  } else if (quickReply) {
    var quickReplyPayload = quickReply.payload;
    console.log("Quick reply for message %s with payload %s",
      messageId, quickReplyPayload);
  }

  if (messageText) {

    // If we receive a text message, check to see if it matches any special
    // keywords and send back the corresponding example. Otherwise, just echo
    // the text we received.
    switch (messageText.toLowerCase()) {
      // case 'image':
      //   sendImageMessage(senderID);
      //   break;
      //
      // case 'gif':
      //   sendGifMessage(senderID);
      //   break;
      //
      // case 'audio':
      //   sendAudioMessage(senderID);
      //   break;
      //
      // case 'video':
      //   sendVideoMessage(senderID);
      //   break;
      //
      // case 'file':
      //   sendFileMessage(senderID);
      //   break;
      //
      // case 'button':
      //   sendButtonMessage(senderID);
      //   break;
      //
      // case 'generic':
      //   sendGenericMessage(senderID);
      //   break;
      //
      // case 'receipt':
      //   sendReceiptMessage(senderID);
      //   break;

      case 'quick reply':
        sendQuickReply(senderID);
        break;

      // case 'read receipt':
      //   sendReadReceipt(senderID);
      //   break;
      //
      // case 'typing on':
      //   sendTypingOn(senderID);
      //   break;
      //
      // case 'typing off':
      //   sendTypingOff(senderID);
      //   break;
      //
      // case 'account linking':
      //   sendAccountLinking(senderID);
      //   break;

      case 'today rate':
        sendHKRateQuickReply(senderID);
        break;

      case 'phl':
        callEMQAPIGetCooridor(senderID, "HKG", "HKD", messageText.toUpperCase(), "PHP");
        break;

      case 'chn':
        callEMQAPIGetCooridor(senderID, "HKG", "HKD", messageText.toUpperCase(), "CNY");
        break;

      case 'ind':
        callEMQAPIGetCooridor(senderID, "HKG", "HKD", messageText.toUpperCase(), "INR");
        break;

      case 'jpn':
        callEMQAPIGetCooridor(senderID, "HKG", "HKD", messageText.toUpperCase(), "JPY");
        break;

      case 'idn':
        callEMQAPIGetCooridor(senderID, "HKG", "HKD", messageText.toUpperCase(), "IDR");
        break;

      case 'vnm':
        callEMQAPIGetCooridor(senderID, "HKG", "HKD",messageText.toUpperCase(), "");
        break;

      case 'vnm-usd':
        callEMQAPIGetCooridor(senderID, "HKG", "HKD","VNM", "USD");
        break;

      case 'vnm-vnd':
        callEMQAPIGetCooridor(senderID, "HKG", "HKD","VNM", "VND");
        break;

      // case 'add menu':
      //   addPersistentMenu();
      //   break;
      //
      // case 'remove menu':
      //   removePersistentMenu();
      //   break;

      default:
        // sendTextMessage(senderID, messageText);
    }
  } else if (messageAttachments) {
    sendTextMessage(senderID, "Message with attachment received");
  }
}


/*
 * Delivery Confirmation Event
 *
 * This event is sent to confirm the delivery of a message. Read more about
 * these fields at https://developers.facebook.com/docs/messenger-platform/webhook-reference/message-delivered
 *
 */
function receivedDeliveryConfirmation(event) {
  var senderID = event.sender.id;
  var recipientID = event.recipient.id;
  var delivery = event.delivery;
  var messageIDs = delivery.mids;
  var watermark = delivery.watermark;
  var sequenceNumber = delivery.seq;

  if (messageIDs) {
    messageIDs.forEach(function(messageID) {
      console.log("Received delivery confirmation for message ID: %s",
        messageID);
    });
  }

  console.log("All message before %d were delivered.", watermark);
}


/*
 * Postback Event
 *
 * This event is called when a postback is tapped on a Structured Message.
 * https://developers.facebook.com/docs/messenger-platform/webhook-reference/postback-received
 *
 */
function receivedPostback(event) {
  var senderID = event.sender.id;
  var recipientID = event.recipient.id;
  var timeOfPostback = event.timestamp;

  // The 'payload' param is a developer-defined field which is set in a postback
  // button for Structured Messages.
  var payload = event.postback.payload;

  console.log("Received postback for user %d and page %d with payload '%s' " +
    "at %d", senderID, recipientID, payload, timeOfPostback);

  // When a postback is called, we'll send a message back to the sender to
  // let them know it was successful

  if (payload) {
    switch (payload) {

      case 'today rate':
        sendHKRateQuickReply(senderID);
        break;

      default:
        sendTextMessage(senderID, messageText);
    }
  }
}

/*
 * Message Read Event
 *
 * This event is called when a previously-sent message has been read.
 * https://developers.facebook.com/docs/messenger-platform/webhook-reference/message-read
 *
 */
function receivedMessageRead(event) {
  var senderID = event.sender.id;
  var recipientID = event.recipient.id;

  // All messages before watermark (a timestamp) or sequence have been seen.
  var watermark = event.read.watermark;
  var sequenceNumber = event.read.seq;

  console.log("Received message read event for watermark %d and sequence " +
    "number %d", watermark, sequenceNumber);
}

/*
 * Account Link Event
 *
 * This event is called when the Link Account or UnLink Account action has been
 * tapped.
 * https://developers.facebook.com/docs/messenger-platform/webhook-reference/account-linking
 *
 */
function receivedAccountLink(event) {
  var senderID = event.sender.id;
  var recipientID = event.recipient.id;

  var status = event.account_linking.status;
  var authCode = event.account_linking.authorization_code;

  console.log("Received account link event with for user %d with status %s " +
    "and auth code %s ", senderID, status, authCode);
}

/*
 * Send an image using the Send API.
 *
 */
function sendImageMessage(recipientId) {
  var messageData = {
    recipient: {
      id: recipientId
    },
    message: {
      attachment: {
        type: "image",
        payload: {
          url: SERVER_URL + "/assets/rift.png"
        }
      }
    }
  };

  callSendAPI(messageData);
}

/*
 * Send a Gif using the Send API.
 *
 */
function sendGifMessage(recipientId) {
  var messageData = {
    recipient: {
      id: recipientId
    },
    message: {
      attachment: {
        type: "image",
        payload: {
          url: SERVER_URL + "/assets/instagram_logo.gif"
        }
      }
    }
  };

  callSendAPI(messageData);
}

/*
 * Send audio using the Send API.
 *
 */
function sendAudioMessage(recipientId) {
  var messageData = {
    recipient: {
      id: recipientId
    },
    message: {
      attachment: {
        type: "audio",
        payload: {
          url: SERVER_URL + "/assets/sample.mp3"
        }
      }
    }
  };

  callSendAPI(messageData);
}

/*
 * Send a video using the Send API.
 *
 */
function sendVideoMessage(recipientId) {
  var messageData = {
    recipient: {
      id: recipientId
    },
    message: {
      attachment: {
        type: "video",
        payload: {
          url: SERVER_URL + "/assets/allofus480.mov"
        }
      }
    }
  };

  callSendAPI(messageData);
}

/*
 * Send a file using the Send API.
 *
 */
function sendFileMessage(recipientId) {
  var messageData = {
    recipient: {
      id: recipientId
    },
    message: {
      attachment: {
        type: "file",
        payload: {
          url: SERVER_URL + "/assets/test.txt"
        }
      }
    }
  };

  callSendAPI(messageData);
}

/*
 * Send a text message using the Send API.
 *
 */
function sendTextMessage(recipientId, messageText) {
  var messageData = {
    recipient: {
      id: recipientId
    },
    message: {
      text: messageText,
      metadata: "DEVELOPER_DEFINED_METADATA"
    }
  };

  callSendAPI(messageData);
}

/*
 * Send a button message using the Send API.
 *
 */
function sendButtonMessage(recipientId) {
  var messageData = {
    recipient: {
      id: recipientId
    },
    message: {
      attachment: {
        type: "template",
        payload: {
          template_type: "button",
          text: "This is test text",
          buttons:[{
            type: "web_url",
            url: "https://www.oculus.com/en-us/rift/",
            title: "Open Web URL"
          }, {
            type: "postback",
            title: "Trigger Postback",
            payload: "DEVELOPER_DEFINED_PAYLOAD"
          }, {
            type: "phone_number",
            title: "Call Phone Number",
            payload: "+16505551234"
          }]
        }
      }
    }
  };

  callSendAPI(messageData);
}

/*
 * Send a Structured Message (Generic Message type) using the Send API.
 *
 */
function sendGenericMessage(recipientId) {
  var messageData = {
    recipient: {
      id: recipientId
    },
    message: {
      attachment: {
        type: "template",
        payload: {
          template_type: "generic",
          elements: [{
            title: "rift",
            subtitle: "Next-generation virtual reality",
            item_url: "https://www.oculus.com/en-us/rift/",
            image_url: SERVER_URL + "/assets/rift.png",
            buttons: [{
              type: "web_url",
              url: "https://www.oculus.com/en-us/rift/",
              title: "Open Web URL"
            }, {
              type: "postback",
              title: "Call Postback",
              payload: "Payload for first bubble",
            }],
          }, {
            title: "touch",
            subtitle: "Your Hands, Now in VR",
            item_url: "https://www.oculus.com/en-us/touch/",
            image_url: SERVER_URL + "/assets/touch.png",
            buttons: [{
              type: "web_url",
              url: "https://www.oculus.com/en-us/touch/",
              title: "Open Web URL"
            }, {
              type: "postback",
              title: "Call Postback",
              payload: "Payload for second bubble",
            }]
          }]
        }
      }
    }
  };

  callSendAPI(messageData);
}

/*
 * Send a receipt message using the Send API.
 *
 */
function sendReceiptMessage(recipientId) {
  // Generate a random receipt ID as the API requires a unique ID
  var receiptId = "order" + Math.floor(Math.random()*1000);

  var messageData = {
    recipient: {
      id: recipientId
    },
    message:{
      attachment: {
        type: "template",
        payload: {
          template_type: "receipt",
          recipient_name: "Peter Chang",
          order_number: receiptId,
          currency: "USD",
          payment_method: "Visa 1234",
          timestamp: "1428444852",
          elements: [{
            title: "Oculus Rift",
            subtitle: "Includes: headset, sensor, remote",
            quantity: 1,
            price: 599.00,
            currency: "USD",
            image_url: SERVER_URL + "/assets/riftsq.png"
          }, {
            title: "Samsung Gear VR",
            subtitle: "Frost White",
            quantity: 1,
            price: 99.99,
            currency: "USD",
            image_url: SERVER_URL + "/assets/gearvrsq.png"
          }],
          address: {
            street_1: "1 Hacker Way",
            street_2: "",
            city: "Menlo Park",
            postal_code: "94025",
            state: "CA",
            country: "US"
          },
          summary: {
            subtotal: 698.99,
            shipping_cost: 20.00,
            total_tax: 57.67,
            total_cost: 626.66
          },
          adjustments: [{
            name: "New Customer Discount",
            amount: -50
          }, {
            name: "$100 Off Coupon",
            amount: -100
          }]
        }
      }
    }
  };

  callSendAPI(messageData);
}

/*
 * Send a message with Quick Reply buttons.
 *
 */
function sendQuickReply(recipientId) {
  var messageData = {
    recipient: {
      id: recipientId
    },
    message: {
      text: "What's your favorite movie genre?",
      quick_replies: [
        {
          "content_type":"text",
          "title":"Action",
          "payload":"DEVELOPER_DEFINED_PAYLOAD_FOR_PICKING_ACTION"
        },
        {
          "content_type":"text",
          "title":"Comedy",
          "payload":"DEVELOPER_DEFINED_PAYLOAD_FOR_PICKING_COMEDY"
        },
        {
          "content_type":"text",
          "title":"Drama",
          "payload":"DEVELOPER_DEFINED_PAYLOAD_FOR_PICKING_DRAMA"
        }
      ]
    }
  };

  callSendAPI(messageData);
}

function sendHKRateQuickReply(recipientId) {
  var messageData = {
    recipient: {
      id: recipientId
    },
    message: {
      text: "Whcih currency would you like to convert HKD into?",
      quick_replies: [
        {
          "content_type":"text",
          "title":"PHL",
          "payload":"DEVELOPER_DEFINED_PAYLOAD_FOR_HK_PHL_FX"
        },
        {
          "content_type":"text",
          "title":"IDN",
          "payload":"DEVELOPER_DEFINED_PAYLOAD_FOR_HK_IDN_FX"
        },
        {
          "content_type":"text",
          "title":"VNM-VND",
          "payload":"DEVELOPER_DEFINED_PAYLOAD_FOR_HK_VNM_VND_FX"
        },
        {
          "content_type":"text",
          "title":"VNM-USD",
          "payload":"DEVELOPER_DEFINED_PAYLOAD_FOR_HK_VNM_USD_FX"
        },
        {
          "content_type":"text",
          "title":"CHN",
          "payload":"DEVELOPER_DEFINED_PAYLOAD_FOR_HK_CHN_FX"
        },
        {
          "content_type":"text",
          "title":"JPN",
          "payload":"DEVELOPER_DEFINED_PAYLOAD_FOR_HK_JPN_FX"
        },
        {
          "content_type":"text",
          "title":"IND",
          "payload":"DEVELOPER_DEFINED_PAYLOAD_FOR_HK_IND_FX"
        }
      ]
    }
  };

  callSendAPI(messageData);
}

/*
 * Send a read receipt to indicate the message has been read
 *
 */
function sendReadReceipt(recipientId) {
  console.log("Sending a read receipt to mark message as seen");

  var messageData = {
    recipient: {
      id: recipientId
    },
    sender_action: "mark_seen"
  };

  callSendAPI(messageData);
}

/*
 * Turn typing indicator on
 *
 */
function sendTypingOn(recipientId) {
  console.log("Turning typing indicator on");

  var messageData = {
    recipient: {
      id: recipientId
    },
    sender_action: "typing_on"
  };

  callSendAPI(messageData);
}

/*
 * Turn typing indicator off
 *
 */
function sendTypingOff(recipientId) {
  console.log("Turning typing indicator off");

  var messageData = {
    recipient: {
      id: recipientId
    },
    sender_action: "typing_off"
  };

  callSendAPI(messageData);
}

/*
 * Send a message with the account linking call-to-action
 *
 */
function sendAccountLinking(recipientId) {
  var messageData = {
    recipient: {
      id: recipientId
    },
    message: {
      attachment: {
        type: "template",
        payload: {
          template_type: "button",
          text: "Welcome. Link your account.",
          buttons:[{
            type: "account_link",
            url: SERVER_URL + "/authorize"
          }]
        }
      }
    }
  };

  callSendAPI(messageData);
}


function sendRateChangedMessage(recipientId, title, message) {
  var messageData = {
    recipient: {
      id: recipientId
    },
    messaging_type: "MESSAGE_TAG",
    tag:"PAYMENT_UPDATE",
    message: {
      attachment: {
        type: "template",
        payload: {
          template_type: "generic",
          elements: [{
            title: title,
            subtitle: message,
            item_url: "https://www.google.com.tw",
            image_url: SERVER_URL + "/assets/rateChanged.png",
            buttons: [{
              type: "web_url",
              url: "https://tw.yahoo.com",
              title: "Submit Again"
            },{
                type: "web_url",
                url: "https://tw.yahoo.com",
                title: "Create a New Transaction"
            }]
          }]
        }
      }
    }
  };

  callSendAPI(messageData);
}

function sendRecipientDataUpdatedMessage(recipientId, title, message, transferId) {
  var messageData = {
    recipient: {
      id: recipientId
    },
    messaging_type: "MESSAGE_TAG",
    tag:"PAYMENT_UPDATE",
    message: {
      attachment: {
        type: "template",
        payload: {
          template_type: "generic",
          elements: [{
            title: title,
            subtitle: message,
            item_url: "http://emq-demo.pre-stage.club",
            image_url: SERVER_URL + "/assets/oneMoreStep.png",
            buttons: [{
              type: "web_url",
              messenger_extensions: true,
              url: EMQ_WEB_SERVICE_URL + "SendMoney_Confirm_Prompt?reference="+transferId,
              title: "Submit"
            }]
          }]
        }
      }
    }
  };

  callSendAPI(messageData);
}

function sendTrasactionStatusUpdatedMessage(recipientId, title, message, transferId) {
  var messageData = {
    recipient: {
      id: recipientId
    },
    messaging_type: "MESSAGE_TAG",
    tag:"PAYMENT_UPDATE",
    message: {
      attachment: {
        type: "template",
        payload: {
          template_type: "generic",
          elements: [{
            title: title,
            subtitle: message,
            item_url: "http://emq-demo.pre-stage.club",
            image_url: SERVER_URL + "/assets/transactionDetail.png",
            buttons: [{
              type: "web_url",
              messenger_extensions: true,
              url: EMQ_WEB_SERVICE_URL+"Transaction?id="+transferId,
              title: "DETAIL"
            }]
          }]
        }
      }
    }
  };

  callSendAPI(messageData);
}

function sendPayoutListMessage(recipientId) {
  var messageData = {
    recipient: {
      id: recipientId
    },
    message: {
      attachment: {
        type: "template",
        payload: {
          template_type: "generic",
          elements: [{
              title: "to Bank Accout",
              subtitle: "Send via\nCircle K: 6.312\nJetcode: 6.345",
              item_url: "https://emq-demo.pre-stage.club",
              image_url: SERVER_URL + "/assets/bank_account.png",
              buttons: [{
                type: "web_url",
                url: "https://emq-demo.pre-stage.club/RequestRecipient_DataSender",
                title: "Make a Transaction"
            }],
          },{
              title: "to Cash Delivery",
              subtitle: "Send via\nCircle K: 6.312\nJetcode: 6.345",
              item_url: "https://emq-demo.pre-stage.club",
              image_url: SERVER_URL + "/assets/cash_delivery.png",
              buttons: [{
                type: "web_url",
                url: "https://emq-demo.pre-stage.club/RequestRecipient_DataSender",
                title: "Make a Transaction"
            }],
          },{
              title: "to Visa",
              subtitle: "Send via\nCircle K: 6.312\nJetcode: 6.345",
              item_url: "https://emq-demo.pre-stage.club",
              image_url: SERVER_URL + "/assets/VISA.png",
              buttons: [{
                type: "web_url",
                url: "https://emq-demo.pre-stage.club/RequestRecipient_DataSender",
                title: "Make a Transaction"
            }],
          }]
        }
      }
    }
  };

  callSendAPI(messageData);
}

function sendPayoutList(recipientId, elements) {
  var messageData = {
    recipient: {
      id: recipientId
    },
    message: {
      attachment: {
        type: "template",
        payload: {
          template_type: "generic",
          elements: elements
        }
      }
    }
  };

  callSendAPI(messageData);
}

/*
 * Call the Send API. The message data goes in the body. If successful, we'll
 * get the message id in a response
 *
 */
function callSendAPI(messageData) {
  request({
    uri: 'https://graph.facebook.com/v2.6/me/messages',
    qs: { access_token: PAGE_ACCESS_TOKEN },
    method: 'POST',
    json: messageData

  }, function (error, response, body) {
    if (!error && response.statusCode == 200) {
      var recipientId = body.recipient_id;
      var messageId = body.message_id;

      if (messageId) {
        console.log("Successfully sent message with id %s to recipient %s",
          messageId, recipientId);
      } else {
      console.log("Successfully called Send API for recipient %s",
        recipientId);
      }
    } else {
      console.error("Failed calling Send API", response.statusCode, response.statusMessage, body.error);
    }
  });
}

function addPersistentMenu(){
 request({
    url: 'https://graph.facebook.com/v2.6/me/messenger_profile',
    qs: { access_token: PAGE_ACCESS_TOKEN },
    method: 'POST',
    json:{
  "get_started":{
    "payload":"GET_STARTED_PAYLOAD"
   }
 }
}, function(error, response, body) {
    console.log("Add persistent menu " + response)
    if (error) {
        console.log('Error sending messages: ', error)
    } else if (response.body.error) {
        console.log('Error: ', response.body.error)
    }
})
 request({
    url: 'https://graph.facebook.com/v2.6/me/messenger_profile',
    qs: { access_token: PAGE_ACCESS_TOKEN },
    method: 'POST',
    json:{
"persistent_menu":[
    {
      "locale":"default",
      "composer_input_disabled":false,
      "messenger_extensions":true,
      "webview_share_button":false,
      "call_to_actions":[
        {
          "type":"web_url",
          "title":"Send someone money",
          "url":"https://emq.pre-stage.club/RequestRecipient_DataSender",
          "webview_height_ratio":"tall",
          "messenger_extensions":false
        },
        {
          "type":"web_url",
          "title":"Request money from someone",
          "url":"https://emq.pre-stage.club/RequestMoney_Calculator",
          "webview_height_ratio":"tall",
          "messenger_extensions":false
        }
      ]
    }
    ]
    }

}, function(error, response, body) {
    console.log(response)
    if (error) {
        console.log('Error sending messages: ', error)
    } else if (response.body.error) {
        console.log('Error: ', response.body.error)
    }
})

}

function removePersistentMenu(){
 request({
    url: 'https://graph.facebook.com/v2.6/me/thread_settings',
    qs: { access_token: PAGE_ACCESS_TOKEN },
    method: 'POST',
    json:{
        setting_type : "call_to_actions",
        thread_state : "existing_thread",
        call_to_actions:[ ]
    }

}, function(error, response, body) {
    console.log(response)
    if (error) {
        console.log('Error sending messages: ', error)
    } else if (response.body.error) {
        console.log('Error: ', response.body.error)
    }
})
}

function callEMQAPIGetCooridor(recipientId, sourceCountry, sourceCurrency, destinationCountry, destinationCurrency) {
  sendTypingOn(recipientId);
  request({
    uri: EMQ_API_URL+'api/v4/transfer/corridors/'+sourceCountry.toUpperCase()+'/'+destinationCountry.toUpperCase(),
    qs: {},
    method: 'GET',
    json: {}

  }, function (error, response, body) {
    if (!error && response.statusCode == 200) {
      var rateDict = {};
      var destPayout = {};
      body.forEach(function(corridor){
        var source = paymentTypeAndPatnerToName(corridor.source.type, sourceCountry, "");
        if (destinationCurrency.length>0) {
          if (destinationCurrency.toLowerCase()!=corridor.dest.currency.toLowerCase()) {
            return;
          }
        }
        if (rateDict[corridor.dest_key]) {
          var stringA = rateDict[corridor.dest_key]["withRate"]+"\n"+source+": "+corridor.rate;
          var stringB = rateDict[corridor.dest_key]["withoutRate"]+", "+source
          rateDict[corridor.dest_key] = {withRate:stringA, withoutRate: stringB};
        }else{
          var stringA = source+": "+corridor.rate;
          var stringB = source;
          rateDict[corridor.dest_key] = {withRate:stringA, withoutRate: stringB};
        }
        if (!destPayout[corridor.dest_key]) {
          destPayout[corridor.dest_key]= {type:corridor.dest.type, partner:corridor.dest.partner, rateList:[corridor.rate]};
        }else{
          var list = destPayout[corridor.dest_key]["rateList"];
          if (list.indexOf(corridor.rate)==-1) {
            list.push(corridor.rate)
          }
        }
      });

      var elemetsList = [];
      Object.keys(rateDict).forEach(function(dest_key){
        var srcString = "";
        var d = destPayout[dest_key];
        var title = "";
        var rateList = destPayout[dest_key]["rateList"];
        if (rateList.length == 1) {
          srcString = "You could send money via\n" + rateDict[dest_key]["withoutRate"];
          title = "to " + paymentTypeAndPatnerToName(d["type"], destinationCountry, d["partner"]) +", 1 "+sourceCurrency+":"+rateList[0]+" "+destinationCurrency;
        }else{
          srcString = "Send via\n" + rateDict[dest_key]["withRate"];
          "to " + paymentTypeAndPatnerToName(d["type"], destinationCountry, d["partner"]);
        }
        var imageName = d["type"]+"_"+destinationCountry.toLowerCase()+"_"+d["partner"]+".png";
        console.log("imageName: %s",imageName);
        var element = {
          title: title,
          subtitle: srcString,
          item_url: "https://emq-demo.pre-stage.club",
          image_url: SERVER_URL + "assets/"+imageName,
          buttons: [{
            type: "web_url",
            messenger_extensions: true,
            url: "https://emq-demo.pre-stage.club?destinationCountry="+destinationCountry+"&destinationCurrency="+destinationCurrency,
            title: "Create a Transaction"
          }]
        }
        elemetsList.push(element);
      });

      sendPayoutList(recipientId, elemetsList);
    } else {
      console.error("Failed calling corridors API", response.statusCode, response.statusMessage, body.error);
    }
  });
}

function setupGetStartedButton(res){
     var messageData = {
             "get_started":[
             {
                 "payload":"USER_DEFINED_PAYLOAD"
                 }
             ]
     };
     // Start the request
     request({
         url: 'https://graph.facebook.com/v2.6/me/messenger_profile?access_token='+ PAGE_ACCESS_TOKEN,
         method: 'POST',
         headers: {'Content-Type': 'application/json'},
         form: messageData
     },
     function (error, response, body) {
         if (!error && response.statusCode == 200) {
             // Print out the response body
             res.send(body);

         } else {
             // TODO: Handle errors
             res.send(body);
         }
     });
 }

 function stringMapping(key) {
   if (key == "payment_method_ewallet_ind_emq_partner_paytm") {
     return "Paytm Payments Bank Account";
   }else if(key == "payment_method_bank_account"){
     return "Bank Account";
   }else if(key == "payment_method_bank"){
     return "Bank Account";
   }else if(key == "payment_method_bank_name_hdbank"){
     return "HDBank";
   }else if(key == "payment_method_cash_delivery"){
     return "Cash Delivery";
   }else if(key == "payment_method_cash_delivery_vnm_agent_name"){
     return "HDBank";
   }else if(key == "payment_method_cash_delivery_vnm_agent_name_emq_bank_hdb"){
     return "HDBank";
   }else if(key == "payment_method_cash_payin"){
     return "Cash Pay-in";
   }else if(key == "payment_method_cash_pickup"){
     return "Cash Pickup";
   }else if(key == "payment_method_cash_pickup_agency_cebuana"){
     return "Cebuana Lhuillier";
   }else if(key == "payment_method_cash_pickup_agent_finnet"){
     return "Delima remittance service";
   }else if(key == "payment_method_cash_pickup_idn_agent_name"){
     return "Delima remittance service";
   }else if(key == "payment_method_cash_pickup_idn_agent_name_emq_partner_finnet"){
     return "Delima remittance service";
   }else if(key == "payment_method_cash_pickup_phl_agent_name"){
     return "Cebuana Lhuillier";
   }else if(key == "payment_method_cash_pickup_phl_agent_name_emq_partner_cebuana"){
     return "Cebuana Lhuillier";
   }else if(key == "payment_method_cash_pickup_phl_agent_name_emq_partner_palawan"){
     return "Palawan";
   }else if(key == "payment_method_cash_pickup_vnm_agent_name"){
     return "HDBank";
   }else if(key == "payment_method_cash_pickup_vnm_agent_name_emq_bank_hdb"){
     return "HDBank";
   }else if(key == "payment_method_circlek"){
     return "Circle K";
   }else if(key == "payment_method_e_wallet"){
     return "E-Wallet";
   }else if(key == "payment_method_e_wallet_service_alipay"){
     return "Alipay";
   }else if(key == "payment_method_ewallet"){
     return "E-Wallet";
   }else if(key == "payment_method_ewallet_ind_agent_name_emq_partner_paytm"){
     return "Paytm Payments Bank";
   }else if(key == "payment_method_ewallet_phl_agent_name"){
     return "GCash";
   }else if(key == "payment_method_ewallet_phl_agent_name_emq_partner_gcash"){
     return "GCash";
   }else if(key == "payment_method_jetco"){
     return "JET PAYMENT";
   }else if(key == "payment_method_local_bank_account"){
     return "HDBank Account";
   }else if(key == "payment_method_local_bank_account_vnm_agent_name"){
     return "HDBank";
   }else if(key == "payment_method_local_bank_account_vnm_agent_name_emq_bank_hdb"){
     return "HDBank";
   }else if(key == "payment_method_visa"){
     return "Visa";
   }else if(key == "payment_method_visa_phl_agent_name"){
     return "Visa";
   }else if(key == "payment_method_visa_phl_agent_name_emq_partner_visa"){
     return "Visa";
   }
   return key;
 }

 function accountMethodWithType(type, country, partner)
  {
    var key1 = "payment_method_"+type+"_"+country.toLowerCase()+"_agent_name_"+partner;
    var string = stringMapping(key1);
    if (string.length>0) {
      return string;
    }else{
      return "";
    }

  }

  function paymentTypeToName(type, country, partner)
  {
      var key1 = "payment_method_"+type+"_"+country+"_"+partner;
      var key2 = "payment_method_"+type;

      if (key1!=stringMapping(key1)) {
          return stringMapping(key1);
      }else if (type == "cash_payin") {
          return stringMapping("payment_method_cash_payin");

      }else if(type == "circlek"){
          return stringMapping("payment_method_circlek");

      }else if(type == "cash-payin") {
          return stringMapping("payment_method_cash_payin");

      }else if (type == "jetco-hkg") {
          return stringMapping("payment_method_jetco");

      }else if (type == "cash_pickup") {
          return stringMapping("payment_method_cash_pickup");
      }else if (type == "e_wallet") {
          return stringMapping("payment_method_e_wallet");
      }else if (type == "ewallet") {
          return stringMapping("payment_method_e_wallet");
      }else if (type == "cash_delivery") {
          return stringMapping("payment_method_cash_delivery");
      }else if(key2 !=stringMapping(key2)){
          return stringMapping(key2);
      }else{
          return type;
      }

  }

 function paymentTypeAndPatnerToName(type, country, partner)
  {
      if (type == "cash_pickup") {
          if (partner.length == 0) {
              return stringMapping("payment_method_cash_pickup");
          }else{
              var p = accountMethodWithType(type, country, partner);
              if (p.length == 0){
                  return stringMapping("payment_method_cash_pickup");
              }else{
                  return stringMapping("payment_method_cash_pickup") + "("+p+")";
              }
          }
      }else if (type == "e_wallet") {
          if (partner.length == 0) {
              return stringMapping("payment_method_e_wallet");
          }else{
            var p = accountMethodWithType(type, country, partner);
            if (p.length == 0){
                return stringMapping("payment_method_e_wallet");
            }else{
                return stringMapping("payment_method_e_wallet") + "("+p+")";
            }
          }
      }else if (type == "ewallet") {
          if (partner.length == 0) {
              return stringMapping("payment_method_e_wallet");
          }else{
            var p = accountMethodWithType(type, country, partner);
            if (p.length == 0){
                return stringMapping("payment_method_e_wallet");
            }else{
                return stringMapping("payment_method_e_wallet") + "("+p+")";
            }
          }
      }else if (type == "cash_delivery"){
          if (partner.length == 0) {
              return stringMapping("payment_method_cash_delivery");
          }else{
            var p = accountMethodWithType(type, country, partner);
            if (p.length == 0){
                return stringMapping("payment_method_cash_delivery");
            }else{
                return stringMapping("payment_method_cash_delivery") + "("+p+")";
            }
          }
      }else{
          return paymentTypeToName(type, country, partner);
      }

  }
// Start server
// Webhooks must be available via SSL with a certificate signed by a valid
// certificate authority.
app.listen(app.get('port'), function() {
  console.log('Node app is running on port', app.get('port'));
});

module.exports = app;
