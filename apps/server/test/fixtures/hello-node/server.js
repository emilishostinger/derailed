// Deliberately dependency-free: this fixture exists to prove that Derailed can
// deploy a repository with no Dockerfile, not to test npm.
//
// It reads PORT, which is the convention Derailed always injects, so a successful
// health check here also proves the injected port reached the app.
const { createServer } = require('node:http');

const port = Number(process.env.PORT || 3000);

createServer((_request, response) => {
  response.writeHead(200, { 'content-type': 'text/plain' });
  response.end('hello from nixpacks\n');
}).listen(port, () => {
  console.log(`listening on ${port}`);
});
