
// templatize this for the env
export default {
    db: {
        url : "mongodb://localhost/sis",
        opts : {
                maxPoolSize: 5,
                writeConcern: {w: 1, j: true}
            }
    },
    server : {
        port : 3000
    },
    app : {
        auth : true,
        auth_config : {
            type : 'sis'
        },
        scripts_enabled : false
    }
};

