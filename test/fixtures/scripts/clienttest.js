// exercises the client API endpoint scripts get
var hosts = client.entities("test_ep_client_hosts");

function fail(err) {
    // SIS errors are [status, body] tuples
    if (Array.isArray(err)) {
        return res.status(err[0]).json(err[1]);
    }
    res.status(500).json({ error : String(err) });
}

if (req.path === "/get") {
    hosts.get(req.query.name).then(function(host) { res.json(host); }, fail);
} else if (req.path === "/list") {
    hosts.listAll({ q : { env : req.query.env }, sort : "name" }).then(function(list) { res.json(list); }, fail);
} else if (req.path === "/schema") {
    Promise.all([client.schemas.get("test_ep_client_hosts"),
                 client.schemas.listAll({ q : { name : "test_ep_client_hosts" } })])
    .then(function(r) { res.json({ get : r[0], list : r[1] }); }, fail);
} else if (req.path === "/hiera") {
    Promise.all([client.hiera.get("test_ep_client_hiera"),
                 client.hiera.listAll({ q : { name : "test_ep_client_hiera" } })])
    .then(function(r) { res.json({ get : r[0], list : r[1] }); }, fail);
} else if (req.path === "/missing") {
    client.entities("test_ep_no_such_schema").get("x").then(function(e) { res.json(e); }, fail);
} else if (req.path === "/unused") {
    // a client for a schema that does not exist, never used
    client.entities("test_ep_no_such_schema");
    res.send("unused");
} else if (req.path === "/reject") {
    // a rejection nothing handles
    Promise.reject(new Error("nobody handles this"));
    res.send("rejected");
} else if (req.path === "/throw") {
    null.boom();
} else {
    res.send("ok");
}
