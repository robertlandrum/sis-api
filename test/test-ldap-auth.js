describe('LDAP authentication', function() {
    "use strict";

    var should = require('should');
    var SIS = require("../util/constants");
    var TestUtil = require('./fixtures/util');
    var FakeLdap = require('./fixtures/fake-ldap');
    var webUtil = require("../routes/webutil");

    var LocalTest = new TestUtil.LocalTest();
    var schemaManager = null;
    var ldap = null;

    before(function(done) {
        LocalTest.start(function(err, mongoose) {
            schemaManager = require("../util/schema-manager")(mongoose, { auth : true });
            done(err);
        });
    });

    before(async function() {
        ldap = await FakeLdap.start({
            "ldap_user@corp.example" : "right",
            "cn=o\\,brien,ou=people,dc=example" : "right"
        });
    });

    after(async function() {
        await ldap.close();
    });

    after(function(done) {
        LocalTest.stop(done);
    });

    // the verify function of the Basic strategy, as passport calls it
    function verifier(authConfig) {
        var config = { auth_config : Object.assign({ type : SIS.AUTH_TYPE_LDAP, url : ldap.url,
                                                     email_domain : "mail.example" }, authConfig) };
        var verify = webUtil.createUserPassStrategy(schemaManager, config)._verify;
        return function(user, pass) {
            return new Promise(function(resolve) {
                verify(user, pass, function(err, result) {
                    resolve({ err : err, user : result });
                });
            });
        };
    }

    it("creates a SIS user for an account the directory accepts", async function() {
        var verify = verifier({ user_domain : "corp.example" });
        var result = await verify("ldap_user", "right");
        should.not.exist(result.err);
        result.user.name.should.eql("ldap_user");
        result.user.email.should.eql("ldap_user@mail.example");
        ldap.binds[ldap.binds.length - 1].should.eql("ldap_user@corp.example");
        var stored = await schemaManager.auth[SIS.SCHEMA_USERS].getById("ldap_user", { lean : true });
        stored.super_user.should.eql(false);
        stored._sis._created_by.should.eql("_sis_ldap_auth_");
    });

    it("uses the existing SIS user the next time", async function() {
        var verify = verifier({ user_domain : "corp.example" });
        var first = await verify("ldap_user", "right");
        var second = await verify("ldap_user", "right");
        String(second.user._id).should.eql(String(first.user._id));
    });

    it("rejects an account the directory does not accept", async function() {
        var result = await verifier({ user_domain : "corp.example" })("ldap_user", "wrong");
        should.not.exist(result.user);
        result.err[0].should.eql(401);
        result.err[1].error.should.match(/LDAP authentication failed/);
    });

    it("binds with the DN template", async function() {
        ldap.accounts["cn=ldap_dn_user,ou=people,dc=example"] = "right";
        var verify = verifier({ bind_dn_template : "cn=%u,ou=people,dc=example" });
        var result = await verify("ldap_dn_user", "right");
        should.not.exist(result.err);
        ldap.binds[ldap.binds.length - 1].should.eql("cn=ldap_dn_user,ou=people,dc=example");
        result.user.name.should.eql("ldap_dn_user");
    });

    it("escapes the user name in the DN template", async function() {
        var verify = verifier({ bind_dn_template : "cn=%u,ou=people,dc=example" });
        // the directory accepts it, but it is not a valid SIS user name
        var result = await verify("o,brien", "right");
        ldap.binds[ldap.binds.length - 1].should.eql("cn=o\\,brien,ou=people,dc=example");
        result.err[0].should.eql(400);
        result.err[1].error.should.match(/name/);
    });

    it("rejects when the directory cannot be reached", async function() {
        var unreachable = "ldap://127.0.0.1:1";
        var config = { auth_config : { type : SIS.AUTH_TYPE_LDAP, url : unreachable, user_domain : "corp.example",
                                       email_domain : "mail.example" } };
        var verify = webUtil.createUserPassStrategy(schemaManager, config)._verify;
        var err = await new Promise(function(resolve) { verify("ldap_user", "right", resolve); });
        err[0].should.eql(401);
        err[1].error.should.match(/LDAP authentication failed/);
    });

    it("requires a url, an email domain and a user domain or DN template", function() {
        [{ type : SIS.AUTH_TYPE_LDAP },
         { type : SIS.AUTH_TYPE_LDAP, url : "ldap://x", user_domain : "d" },
         { type : SIS.AUTH_TYPE_LDAP, url : "ldap://x", email_domain : "e" }].forEach(function(authConfig) {
            (function() {
                webUtil.createUserPassStrategy(schemaManager, { auth_config : authConfig });
            }).should.throw(/LDAP authentication requires/);
        });
    });
});
