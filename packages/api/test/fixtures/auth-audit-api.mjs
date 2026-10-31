import path from 'node:path';
// Keep dotenv away from the developer's repository/profile configuration.
if (!process.env.CYBERSAFE_DB_PATH) throw new Error('Isolated fixture database required');
process.chdir(path.dirname(process.env.CYBERSAFE_DB_PATH));
const {app}=await import('../../dist/index.js');
const {closeDb}=await import('../../dist/db.js');
const delay=Number(process.env.AUDIT_START_DELAY_MS)||0;
if(delay>0)await new Promise(resolve=>setTimeout(resolve,delay));
const server=app.listen(Number(process.env.AUDIT_LISTEN_PORT)||0,'127.0.0.1',()=>process.send({base:'http://127.0.0.1:'+server.address().port}));
process.on('message',message=>{if(message==='stop'){server.closeAllConnections();server.close(()=>{closeDb();process.exit(0)})}});
