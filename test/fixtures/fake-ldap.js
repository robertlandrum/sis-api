import net from "net";

// A minimal LDAP server for the tests: it answers simple bind requests,
// accepting the DN / password pairs it is given, and ends the connection
// on an unbind.  Messages are BER encoded (RFC 4511).

var SEQUENCE = 0x30;
var INTEGER = 0x02;
var OCTET_STRING = 0x04;
var ENUMERATED = 0x0a;
var BIND_REQUEST = 0x60;
var BIND_RESPONSE = 0x61;
var UNBIND_REQUEST = 0x42;
var SIMPLE_AUTH = 0x80;

var SUCCESS = 0;
var INVALID_CREDENTIALS = 49;

// Read the TLV at offset - null if buf does not hold all of it yet
function readTlv(buf, offset) {
    if (offset + 2 > buf.length) {
        return null;
    }
    var tag = buf[offset];
    var len = buf[offset + 1];
    var start = offset + 2;
    if (len & 0x80) {
        var bytes = len & 0x7f;
        if (start + bytes > buf.length) {
            return null;
        }
        len = 0;
        for (var i = 0; i < bytes; i++) {
            len = (len * 256) + buf[start + i];
        }
        start += bytes;
    }
    if (start + len > buf.length) {
        return null;
    }
    return { tag : tag, value : buf.subarray(start, start + len), end : start + len };
}

// The TLVs in value
function readAll(value) {
    var result = [];
    var offset = 0;
    while (offset < value.length) {
        var tlv = readTlv(value, offset);
        result.push(tlv);
        offset = tlv.end;
    }
    return result;
}

function tlv(tag, value) {
    var len = value.length;
    var header = len < 0x80 ? Buffer.from([tag, len]) : Buffer.from([tag, 0x82, len >> 8, len & 0xff]);
    return Buffer.concat([header, value]);
}

function integer(tag, n) {
    // small non negative integers only
    return tlv(tag, n < 0x80 ? Buffer.from([n]) : Buffer.from([0, n]));
}

function bindResponse(messageId, resultCode) {
    var op = tlv(BIND_RESPONSE, Buffer.concat([
        integer(ENUMERATED, resultCode),
        tlv(OCTET_STRING, Buffer.alloc(0)),
        tlv(OCTET_STRING, Buffer.from(resultCode === SUCCESS ? "" : "Invalid credentials"))
    ]));
    return tlv(SEQUENCE, Buffer.concat([integer(INTEGER, messageId), op]));
}

// Start a server that accepts the binds in accounts ({ dn : password }).
// Resolves with { url, accounts, binds, close() } - binds lists the DNs
// bound with, and accounts can be added to.
export function start(accounts) {
    var binds = [];
    var server = net.createServer(function(socket) {
        var pending = Buffer.alloc(0);
        socket.on("data", function(data) {
            pending = Buffer.concat([pending, data]);
            var message;
            while ((message = readTlv(pending, 0))) {
                pending = pending.subarray(message.end);
                var parts = readAll(message.value);
                var messageId = parts[0].value.readUIntBE(0, parts[0].value.length);
                var op = parts[1];
                if (op.tag === UNBIND_REQUEST) {
                    socket.end();
                    return;
                }
                if (op.tag !== BIND_REQUEST) {
                    socket.destroy();
                    return;
                }
                var fields = readAll(op.value);
                var dn = fields[1].value.toString();
                var auth = fields[2];
                var password = auth.tag === SIMPLE_AUTH ? auth.value.toString() : null;
                binds.push(dn);
                var ok = Object.prototype.hasOwnProperty.call(accounts, dn) && accounts[dn] === password;
                socket.write(bindResponse(messageId, ok ? SUCCESS : INVALID_CREDENTIALS));
            }
        });
        socket.on("error", function() { });
    });
    return new Promise(function(resolve) {
        server.listen(0, "127.0.0.1", function() {
            resolve({
                url : "ldap://127.0.0.1:" + server.address().port,
                accounts : accounts,
                binds : binds,
                close : function() {
                    return new Promise(function(done) { server.close(done); });
                }
            });
        });
    });
}
