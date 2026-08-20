module.exports = {
  apps: [
    {
      name: "signal-signage",
      script: "server/server.js",
      cwd: __dirname,
      env: {
        NODE_ENV: "production"
      },
      autorestart: true,
      max_restarts: 10,
      restart_delay: 3000
    }
  ]
};
