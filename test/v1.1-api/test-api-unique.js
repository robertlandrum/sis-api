describe('@API @V1.1API - Unique fields', function() {
    "use strict";

    var should = require('should');

    var TestUtil = require('../fixtures/util');

    var ApiServer = new TestUtil.TestServer();

    function uniqueSchema(name) {
        return {
            name : name,
            _sis : { owner : ["sistest"] },
            definition : {
                host : { type : "String", required : true, unique : true }
            }
        };
    }

    // the response of a write rejected because a unique value is taken
    function shouldBeConflict(res, field, value) {
        res.body.should.eql({
            error : "Conflict: " + field + " " + JSON.stringify(value) + " already exists",
            code : 1005
        });
    }

    before(async function() {
        await ApiServer.start();
        await ApiServer.becomeSuperUser();
    });

    after(async function() {
        await ApiServer.stop();
    });

    describe("conflicts", function() {
        var name = "test_unique_conflicts";
        var other = null;

        before(async function() {
            await ApiServer.del("/api/v1.1/schemas/" + name);
            await ApiServer.post("/api/v1.1/schemas").send(uniqueSchema(name)).expect(201);
            await ApiServer.post("/api/v1.1/entities/" + name).send({ host : "taken" }).expect(201);
            other = (await ApiServer.post("/api/v1.1/entities/" + name).send({ host : "free" }).expect(201)).body;
        });

        after(async function() {
            await ApiServer.del("/api/v1.1/schemas/" + name);
        });

        it("Should reject adding a taken value with 409", async function() {
            var res = await ApiServer.post("/api/v1.1/entities/" + name).send({ host : "taken" }).expect(409);
            shouldBeConflict(res, "host", "taken");
        });

        it("Should reject changing a value to a taken one with 409", async function() {
            var res = await ApiServer.put("/api/v1.1/entities/" + name + "/" + other._id).send({ host : "taken" })
                .expect(409);
            shouldBeConflict(res, "host", "taken");
        });

        it("Should reject a schema with a taken name with 409", async function() {
            var dupe = uniqueSchema(name);
            dupe.definition = { a : "String" };
            var res = await ApiServer.post("/api/v1.1/schemas").send(dupe).expect(409);
            shouldBeConflict(res, "name", name);
        });

        it("Should not send internal details such as a stack trace", async function() {
            var res = await ApiServer.post("/api/v1.1/entities/" + name).send({ host : "taken" }).expect(409);
            res.text.should.not.match(/\n\s+at /);
            res.text.should.not.match(/node_modules|MongoServerError|E11000/);
        });
    });

    // Mongoose builds the indexes of a new schema in the background; writes
    // must not get ahead of the unique index (a duplicate written first even
    // keeps the index from being built).
    describe("writes right after a schema is created", function() {
        var names = [];

        after(async function() {
            await Promise.all(names.map(function(n) {
                return ApiServer.del("/api/v1.1/schemas/" + n);
            }));
        });

        async function createSchema(n) {
            names.push(n);
            await ApiServer.del("/api/v1.1/schemas/" + n);
            await ApiServer.post("/api/v1.1/schemas").send(uniqueSchema(n)).expect(201);
        }

        async function countHosts(n, host) {
            var q = encodeURIComponent(JSON.stringify({ host : host }));
            return (await ApiServer.get("/api/v1.1/entities/" + n + "?q=" + q).expect(200)).body.length;
        }

        it("Should reject a duplicate written right after the first", async function() {
            for (var i = 0; i < 10; ++i) {
                var n = "test_unique_seq_" + i;
                await createSchema(n);
                await ApiServer.post("/api/v1.1/entities/" + n).send({ host : "same" }).expect(201);
                await ApiServer.post("/api/v1.1/entities/" + n).send({ host : "same" }).expect(409);
                (await countHosts(n, "same")).should.eql(1);
            }
        });

        it("Should accept exactly one of simultaneous writes of the same value", async function() {
            var n = "test_unique_parallel";
            await createSchema(n);
            var responses = await Promise.all([1, 2, 3, 4].map(function() {
                return ApiServer.post("/api/v1.1/entities/" + n).send({ host : "same" });
            }));
            responses.map(function(r) { return r.status; }).sort().should.eql([201, 409, 409, 409]);
            (await countHosts(n, "same")).should.eql(1);
        });

        it("Should enforce the unique index on a field made unique by an update", async function() {
            var n = "test_unique_update";
            var schema = uniqueSchema(n);
            schema.definition = { host : "String" };
            names.push(n);
            await ApiServer.del("/api/v1.1/schemas/" + n);
            await ApiServer.post("/api/v1.1/schemas").send(schema).expect(201);
            schema.definition = { host : { type : "String", unique : true } };
            await ApiServer.put("/api/v1.1/schemas/" + n).send(schema).expect(200);
            await ApiServer.post("/api/v1.1/entities/" + n).send({ host : "same" }).expect(201);
            await ApiServer.post("/api/v1.1/entities/" + n).send({ host : "same" }).expect(409);
        });
    });
});
