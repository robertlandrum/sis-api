describe('@API @V1.1API - Custom Types', function() {
    "use strict";

    var should = require('should');

    var SIS = require("../../util/constants");

    var TestUtil = require('../fixtures/util');

    var ApiServer = new TestUtil.TestServer();

    it("Should setup fixtures", async function() {
        await ApiServer.start();
        await ApiServer.becomeSuperUser();
    });

    after(async function() {
        await ApiServer.stop();
    });

    var ip10_1_1_1_24 = {
        "ip_address":"10.1.1.1",
        "version":"v4",
        "cidr":24,
        "network":"10.1.1.0",
        "broadcast":"10.1.1.255",
        "subnet_mask":"255.255.255.0"
    };

    var ip6_1 = {
        "subnet_mask":"ffff:ffff:ffff:ffff:ffff:ffff:f000:0000",
        "broadcast":"2001:0000:ce49:7601:e866:efff:6fff:ffff",
        "network":"2001:0000:ce49:7601:e866:efff:6000:0000",
        "cidr":100,
        "version":"v6",
        "ip_address":"2001:0:ce49:7601:e866:efff:62c3:fffe"
    };

    describe("IpAddress Single", function() {
        var schema = {
            "name" : "test_host",
            _sis : { "owner" : "ip_test" },
            "definition" : {
                "name" : "String",
                "ip" : { "type" : "IpAddress", "required" : true }
            }
        };

        before(async function() {
            await ApiServer.del('/api/v1.1/schemas/test_host');
            await ApiServer.post("/api/v1.1/schemas")
                .set('content-type', 'application/json')
                .send(schema)
                .expect(201);
        });

        after(async function() {
            await ApiServer.del("/api/v1.1/schemas/test_host")
                .expect(200);
        });

        it("Should add 10.1.1.1/24", async function() {
            var entity = {
                name : "v4_test",
                ip : "10.1.1.1/24"
            };
            var res = (await ApiServer.post("/api/v1.1/entities/test_host")
                .set('content-type', 'application/json')
                .send(entity)
                .expect(201)).body;
            should.exist(res.ip);
            res.ip.should.eql(ip10_1_1_1_24);
        });

        it("Should add 2001:0:ce49:7601:e866:efff:62c3:fffe/100", async function() {
            var entity = {
                name : "v6_test",
                ip : "2001:0:ce49:7601:e866:efff:62c3:fffe/100"
            };
            var res = (await ApiServer.post("/api/v1.1/entities/test_host")
                .set('content-type', 'application/json')
                .send(entity)
                .expect(201)).body;
            should.exist(res.ip);
            res.ip.should.eql(ip6_1);
        });

        it("Should fetch 10.1.1.1/24", async function() {
            var query = {
                q : { "ip.ip_address" : "10.1.1.1" }
            };
            var res = (await ApiServer.get("/api/v1.1/entities/test_host")
                .query(query)
                .expect(200)).body;
            res.length.should.eql(1);
            should.exist(res[0].ip);
            res[0].ip.should.eql(ip10_1_1_1_24);
        });
    });

    describe("IpAddress Multi", function() {
        var schema = {
            "name" : "test_host",
            _sis : { "owner" : "ip_test" },
            "definition" : {
                "name" : "String",
                "ips" : ["IpAddress"]
            }
        };

        before(async function() {
            await ApiServer.post("/api/v1.1/schemas")
                .set('content-type', 'application/json')
                .send(schema)
                .expect(201);
        });

        after(async function() {
            await ApiServer.del("/api/v1.1/schemas/test_host")
                .expect(200);
        });

        it("Should add multiple ips", async function() {
            var entity = {
                name : "v4_test",
                ips : ["10.1.1.1/24", "2001:0:ce49:7601:e866:efff:62c3:fffe/100"]
            };
            var ips = (await ApiServer.post("/api/v1.1/entities/test_host")
                .set('content-type', 'application/json')
                .send(entity)
                .expect(201)).body.ips;
            should.exist(ips);
            ips.length.should.eql(2);
            ips[0].should.eql(ip10_1_1_1_24);
            ips[1].should.eql(ip6_1);
        });
    });
});
