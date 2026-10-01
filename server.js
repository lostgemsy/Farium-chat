require('dotenv').config();
const express=require('express');
const http=require('http');
const path=require('path');
const fs=require('fs');
const crypto=require('crypto');
const bcrypt=require('bcryptjs');
const cookieParser=require('cookie-parser');
const multer=require('multer');
const {Server}=require('socket.io');
const app=express();
const server=http.createServer(app);
const io=new Server(server,{maxHttpBufferSize:2e6});
app.set('trust proxy',String(process.env.TRUST_PROXY||'1')==='0'?false:true);
app.use(express.json({limit:'1mb'}));
app.use(cookieParser());
app.use(express.urlencoded({extended:true}));
app.use(express.static(path.join(__dirname,'public')));

const dataDir=path.join(__dirname,'data'); const dbFile=path.join(dataDir,'db.json');
if(!fs.existsSync(dataDir))fs.mkdirSync(dataDir,{recursive:true});
function fresh(){return {users:[],sessions:[],friendRequests:[],groups:[],globalMessages:[],groupMessages:{},bans:[],announcements:[],ownerMessages:[],config:{lockdownUntil:0,lockdownReason:'',chatResetOn:false,hud:{enabled:false,text:'',x:50,y:16,scale:1}}}}
let db; try{db=JSON.parse(fs.readFileSync(dbFile,'utf8'))}catch{db=fresh()}
function save(){fs.writeFileSync(dbFile,JSON.stringify(db,null,2))}
for(const k of Object.keys(fresh()))if(db[k]===undefined)db[k]=fresh()[k];
const randomId=()=>crypto.randomBytes(12).toString('hex'); const now=()=>Date.now();
const ownerName=(process.env.OWNER_USERNAME||'hohogames').toLowerCase(); const maxMsg=Math.min(Math.max(Number(process.env.MAX_MESSAGE_LENGTH||500),50),2000);
const sessionsByToken=token=>db.sessions.find(s=>s.token===token&&s.expires>now());
function currentUser(req){const token=req.cookies.hgs_session;const s=token&&sessionsByToken(token);return s?db.users.find(u=>u.id===s.userId):null}
function safeUser(u){if(!u)return null;return {id:u.id,username:u.username,role:u.role,avatar:u.avatar||null,createdAt:u.createdAt,mutedUntil:u.mutedUntil||0}}
function auth(req,res,next){const u=currentUser(req);if(!u)return res.status(401).json({error:'Sign in required.'});req.user=u;next()}
function admin(req,res,next){auth(req,res,()=>{if(!['owner','admin'].includes(req.user.role))return res.status(403).json({error:'Admin access required.'});next()})}
function owner(req,res,next){auth(req,res,()=>{if(req.user.role!=='owner')return res.status(403).json({error:'Owner access required.'});next()})}
function clientIp(req){return String(req.ip||req.socket.remoteAddress||'').replace(/^::ffff:/,'')}
function isBannedIp(ip){return db.bans.some(b=>b.ip===ip)}
function checkAccess(req,res,next){if(isBannedIp(clientIp(req)))return res.status(403).json({error:'This IP is banned.'});next()}
app.use('/api',checkAccess);

const avatarStorage=multer.diskStorage({destination:(req,file,cb)=>cb(null,path.join(__dirname,'public/uploads/avatars')),filename:(req,file,cb)=>cb(null,`${randomId()}${path.extname(file.originalname).toLowerCase()}`)});
const soundStorage=multer.diskStorage({destination:(req,file,cb)=>cb(null,path.join(__dirname,'public/uploads/sounds')),filename:(req,file,cb)=>cb(null,`${randomId()}.mp3`)});
const avatarUpload=multer({storage:avatarStorage,limits:{fileSize:2*1024*1024},fileFilter:(req,file,cb)=>cb(/image\/(png|jpe?g|webp)/.test(file.mimetype)?null:new Error('Use PNG, JPG, or WEBP.'))});
const soundUpload=multer({storage:soundStorage,limits:{fileSize:10*1024*1024},fileFilter:(req,file,cb)=>cb((file.mimetype==='audio/mpeg'||path.extname(file.originalname).toLowerCase()==='.mp3')?null:new Error('Use an MP3 file.'))});

app.get('/api/me',(req,res)=>{const u=currentUser(req);let token=req.cookies.hgs_session; if(!u) token=null; res.json({user:safeUser(u),token})});
app.post('/api/register',async(req,res)=>{const username=String(req.body.username||'').trim(), password=String(req.body.password||'');if(!/^[a-zA-Z0-9_\-]{3,24}$/.test(username))return res.status(400).json({error:'Username must be 3–24 letters, numbers, _ or -.'});if(password.length<6)return res.status(400).json({error:'Password must be at least 6 characters.'});if(db.users.length===0&&username.toLowerCase()!==ownerName)return res.status(400).json({error:`The first account must be ${ownerName}.`});if(db.users.some(u=>u.username.toLowerCase()===username.toLowerCase()))return res.status(409).json({error:'Username is already taken.'});const role=db.users.length===0?'owner':'user';const u={id:randomId(),username,passwordHash:await bcrypt.hash(password,12),role,avatar:null,createdAt:now(),mutedUntil:0};db.users.push(u);save();const token=randomId()+randomId();db.sessions.push({token,userId:u.id,expires:now()+864e5*Number(process.env.SESSION_DAYS||30)});save();res.cookie('hgs_session',token,{httpOnly:true,sameSite:'lax',secure:req.secure||false,maxAge:864e5*Number(process.env.SESSION_DAYS||30)});res.json({user:safeUser(u),token})});
app.post('/api/login',async(req,res)=>{const username=String(req.body.username||'').trim();const password=String(req.body.password||'');const u=db.users.find(x=>x.username.toLowerCase()===username.toLowerCase());if(!u||!(await bcrypt.compare(password,u.passwordHash)))return res.status(401).json({error:'Invalid username or password.'});const token=randomId()+randomId();db.sessions=db.sessions.filter(s=>s.expires>now());db.sessions.push({token,userId:u.id,expires:now()+864e5*Number(process.env.SESSION_DAYS||30)});save();res.cookie('hgs_session',token,{httpOnly:true,sameSite:'lax',secure:req.secure||false,maxAge:864e5*Number(process.env.SESSION_DAYS||30)});res.json({user:safeUser(u),token})});
app.post('/api/logout',auth,(req,res)=>{const token=req.cookies.hgs_session;db.sessions=db.sessions.filter(s=>s.token!==token);save();res.clearCookie('hgs_session');res.json({ok:true})});
app.get('/api/global',(req,res)=>res.json({messages:db.globalMessages.slice(-500)}));

app.get('/api/profile',auth,(req,res)=>res.json({user:safeUser(req.user)}));
app.patch('/api/profile',auth,(req,res)=>{save();res.json({user:safeUser(req.user)})});
app.post('/api/profile/avatar',auth,avatarUpload.single('avatar'),(req,res)=>{if(!req.file)return res.status(400).json({error:'Choose an image.'});req.user.avatar=`/uploads/avatars/${req.file.filename}`;save();io.emit('presence',onlinePayload());res.json({user:safeUser(req.user)})});

app.get('/api/friends',auth,(req,res)=>{const sent=db.friendRequests.filter(x=>x.to===req.user.id&&x.status==='pending').map(x=>{const u=db.users.find(y=>y.id===x.from);return {id:x.id,username:u?.username,avatar:u?.avatar||null}});const ids=[];for(const f of db.friendRequests.filter(x=>x.status==='accepted')){if(f.from===req.user.id)ids.push(f.to);if(f.to===req.user.id)ids.push(f.from)}const friends=ids.map(id=>safeUser(db.users.find(u=>u.id===id))).filter(Boolean);res.json({friends,requests:sent})});
app.post('/api/friends/request',auth,(req,res)=>{const name=String(req.body.username||'').trim();const target=db.users.find(u=>u.username.toLowerCase()===name.toLowerCase());if(!target||target.id===req.user.id)return res.status(404).json({error:'User not found.'});if(db.friendRequests.some(x=>x.from===req.user.id&&x.to===target.id&&(x.status==='pending'||x.status==='accepted')))return res.status(409).json({error:'Request already exists.'});db.friendRequests.push({id:randomId(),from:req.user.id,to:target.id,status:'pending',at:now()});save();res.json({ok:true})});
app.post('/api/friends/accept',auth,(req,res)=>{const f=db.friendRequests.find(x=>x.id===req.body.requestId&&x.to===req.user.id);if(!f)return res.status(404).json({error:'Request not found.'});f.status='accepted';save();res.json({ok:true})});

app.get('/api/groups',auth,(req,res)=>res.json({groups:db.groups.filter(g=>g.members.includes(req.user.id)).map(g=>({...g}))}));
app.post('/api/groups',auth,(req,res)=>{const name=String(req.body.name||'').trim().slice(0,50);if(!name)return res.status(400).json({error:'Group name required.'});const g={id:randomId(),name,ownerId:req.user.id,members:[req.user.id],createdAt:now()};db.groups.push(g);db.groupMessages[g.id]=[];save();res.json({group:g})});
app.post('/api/groups/:id/invite',auth,(req,res)=>{const g=db.groups.find(x=>x.id===req.params.id&&x.members.includes(req.user.id));if(!g)return res.status(404).json({error:'Group not found.'});const f=db.friendRequests.find(x=>x.status==='accepted'&&((x.from===req.user.id&&db.users.find(u=>u.id===x.to)?.username.toLowerCase()===String(req.body.username||'').toLowerCase())||(x.to===req.user.id&&db.users.find(u=>u.id===x.from)?.username.toLowerCase()===String(req.body.username||'').toLowerCase())));if(!f)return res.status(400).json({error:'That person is not your friend.'});const id=f.from===req.user.id?f.to:f.from;if(!g.members.includes(id))g.members.push(id);save();res.json({ok:true})});
app.get('/api/groups/:id/messages',auth,(req,res)=>{const g=db.groups.find(x=>x.id===req.params.id&&x.members.includes(req.user.id));if(!g)return res.status(404).json({error:'Group not found.'});res.json({messages:(db.groupMessages[g.id]||[]).slice(-500)})});

app.get('/api/admin/users',admin,(req,res)=>res.json({users:db.users.map(safeUser)}));
app.get('/api/admin/overview',admin,(req,res)=>res.json({bans:db.bans.slice(-200)}));
app.post('/api/admin/mute',admin,(req,res)=>{if(req.body.userId===req.user.id)return res.status(400).json({error:'You cannot mute yourself.'});const u=db.users.find(x=>x.id===req.body.userId);if(!u)return res.status(404).json({error:'User not found.'});u.mutedUntil=now()+Math.min(Number(req.body.minutes||10),120)*60000;save();io.to(`user:${u.id}`).emit('moderation:muted',{until:u.mutedUntil});res.json({ok:true})});
app.post('/api/admin/bans',admin,(req,res)=>{const target=db.users.find(x=>x.id===req.body.userId);if(!target)return res.status(404).json({error:'User not found.'});const ip=onlineIpForUser(target.id);if(!ip)return res.status(400).json({error:'That user is not currently online. IP bans require them to be online.'});if(!db.bans.some(b=>b.ip===ip))db.bans.push({ip,reason:String(req.body.reason||'Community moderation'),createdBy:req.user.username,at:now()});save();for(const s of io.sockets.sockets.values())if(s.user?.id===target.id)s.disconnect(true);res.json({ok:true,ip})});
app.post('/api/admin/bans/unban',admin,(req,res)=>{const ip=String(req.body.ip||'');db.bans=db.bans.filter(b=>b.ip!==ip);save();res.json({ok:true})});
app.post('/api/admin/role',owner,(req,res)=>{const u=db.users.find(x=>x.id===req.body.userId);if(!u||u.role==='owner')return res.status(404).json({error:'User not found or protected.'});const role=req.body.role==='admin'?'admin':'user';u.role=role;save();io.emit('admin:refresh');res.json({user:safeUser(u)})});
app.get('/api/admin/config',admin,(req,res)=>res.json({config:db.config}));
app.patch('/api/admin/config',admin,(req,res)=>{if(req.body.hud){db.config.hud={...db.config.hud,...req.body.hud}}save();io.emit('hud:update',db.config.hud);res.json({config:db.config})});
app.post('/api/admin/lockdown',admin,(req,res)=>{const minutes=Math.max(0,Math.min(Number(req.body.minutes||0),120));db.config.lockdownUntil=minutes?now()+minutes*60000:0;db.config.lockdownReason=String(req.body.reason||'');save();io.emit('lockdown',{until:db.config.lockdownUntil,reason:db.config.lockdownReason});res.json({ok:true})});
app.post('/api/admin/reset-chat',admin,(req,res)=>{db.globalMessages=[];db.config.chatResetOn=!!req.body.on;save();io.emit('chat:reset');res.json({ok:true})});
app.get('/api/admin/sounds',admin,(req,res)=>{const dir=path.join(__dirname,'public/uploads/sounds');const files=fs.readdirSync(dir).filter(f=>f.endsWith('.mp3')).map(f=>({name:f.replace(/^[0-9a-f]+-/,'').replace(/\.mp3$/i,''),url:`/uploads/sounds/${f}`}));res.json({sounds:files})});
app.post('/api/admin/sounds',admin,soundUpload.single('sound'),(req,res)=>{if(!req.file)return res.status(400).json({error:'Choose an MP3.'});const name=String(req.body.name||req.file.originalname.replace(/\.mp3$/i,'')).slice(0,60).replace(/[^\w\- ]/g,'');const final=`${randomId()}-${name||'sound'}.mp3`;fs.renameSync(req.file.path,path.join(req.file.destination,final));res.json({sound:{name,url:`/uploads/sounds/${final}`}})});
app.get('/api/admin/inbox',owner,(req,res)=>res.json({messages:db.ownerMessages.slice(-300)}));

const sockets=new Map(); const voiceQueue=[];
function onlineIpForUser(id){for(const [sid,s] of sockets.entries())if(s.user?.id===id)return s.ip}
function onlinePayload(){return {users:[...sockets.values()].map(s=>safeUser(s.user)).filter(Boolean)}}
function assertSocket(s){if(!s.user)throw new Error('Sign in required.');const banned=isBannedIp(s.ip);if(banned)throw new Error('This IP is banned.');if(db.config.lockdownUntil>now()&&!['owner','admin'].includes(s.user.role))throw new Error('The site is temporarily paused.');if(s.user.mutedUntil>now())throw new Error('You are muted until '+new Date(s.user.mutedUntil).toLocaleTimeString())}
io.on('connection',socket=>{socket.ip=String(socket.handshake.address||'').replace(/^::ffff:/,'');socket.on('auth:login',({token})=>{const sess=sessionsByToken(token);const u=sess&&db.users.find(x=>x.id===sess.userId);if(!u)return;socket.user=u;sockets.set(socket.id,socket);socket.join(`user:${u.id}`);io.emit('presence',onlinePayload());socket.emit('hud:update',db.config.hud);socket.emit('lockdown',{until:db.config.lockdownUntil,reason:db.config.lockdownReason});socket.emit('announcement',db.announcements.at(-1)||{});});
 socket.on('presence:ask',()=>socket.emit('presence',onlinePayload()));
 socket.on('chat:send',({text},ack)=>{try{assertSocket(socket);const t=String(text||'').trim();if(!t)throw new Error('Message is empty.');if(t.length>maxMsg)throw new Error(`Message must be under ${maxMsg} characters.`);if(db.config.chatResetOn)throw new Error('Global chat is currently reset.');const m={id:randomId(),userId:socket.user.id,username:socket.user.username,role:socket.user.role,avatar:socket.user.avatar||null,text:t,at:now()};db.globalMessages.push(m);db.globalMessages=db.globalMessages.slice(-1000);save();io.emit('chat:message',m);ack?.({ok:true})}catch(e){ack?.({error:e.message})}});
 socket.on('group:send',({groupId,text},ack)=>{try{assertSocket(socket);const g=db.groups.find(x=>x.id===groupId&&x.members.includes(socket.user.id));if(!g)throw new Error('You are not in that group.');const t=String(text||'').trim();if(!t)throw new Error('Message is empty.');const m={id:randomId(),groupId,userId:socket.user.id,username:socket.user.username,role:socket.user.role,avatar:socket.user.avatar||null,text:t.slice(0,maxMsg),at:now()};db.groupMessages[groupId]=db.groupMessages[groupId]||[];db.groupMessages[groupId].push(m);db.groupMessages[groupId]=db.groupMessages[groupId].slice(-500);save();for(const s of sockets.values())if(s.user&&g.members.includes(s.user.id))s.emit('group:message',m);ack?.({ok:true})}catch(e){ack?.({error:e.message})}});
 socket.on('owner:message',({text},ack)=>{try{assertSocket(socket);const t=String(text||'').trim();if(!t)throw new Error('Message is empty.');const m={id:randomId(),userId:socket.user.id,username:socket.user.username,text:t.slice(0,1000),at:now()};db.ownerMessages.push(m);db.ownerMessages=db.ownerMessages.slice(-300);save();for(const s of sockets.values())if(s.user?.role==='owner')s.emit('owner:message',m);ack?.({ok:true})}catch(e){ack?.({error:e.message})}});
 socket.on('admin:announcement',({text},ack)=>{try{if(!['owner','admin'].includes(socket.user?.role))throw new Error('Admin access required.');const t=String(text||'').trim();if(!t)throw new Error('Announcement is empty.');const a={id:randomId(),text:t.slice(0,300),by:socket.user.username,at:now()};db.announcements.push(a);db.announcements=db.announcements.slice(-50);save();io.emit('announcement',a);ack?.({ok:true})}catch(e){ack?.({error:e.message})}});
 socket.on('admin:troll',({sound,name})=>{if(['owner','admin'].includes(socket.user?.role))io.emit('troll:play',{sound,name})});
 socket.on('voice:join',async()=>{try{if(!socket.user)throw new Error('Sign in required.');if(!voiceQueue.includes(socket.id))voiceQueue.push(socket.id);if(voiceQueue.length>=2){const a=voiceQueue.shift(),b=voiceQueue.shift();const sa=io.sockets.sockets.get(a),sb=io.sockets.sockets.get(b);if(sa&&sb){sa.peerId=b;sb.peerId=a;sa.emit('voice:matched',{peerId:b});sb.emit('voice:matched',{peerId:a})}}}catch(e){socket.emit('voice:error',e.message)}});
 socket.on('voice:leave',()=>{const idx=voiceQueue.indexOf(socket.id);if(idx>=0)voiceQueue.splice(idx,1);const peer=socket.peerId;socket.peerId=null;if(peer){const ps=io.sockets.sockets.get(peer);if(ps){ps.peerId=null;ps.emit('voice:ended')}}});
 socket.on('voice:offer',({to,offer})=>{const ps=io.sockets.sockets.get(to);if(ps)ps.emit('voice:offer',{from:socket.id,offer})});socket.on('voice:answer',({to,answer})=>{const ps=io.sockets.sockets.get(to);if(ps)ps.emit('voice:answer',{from:socket.id,answer})});socket.on('voice:ice',({to,candidate})=>{const ps=io.sockets.sockets.get(to);if(ps)ps.emit('voice:ice',{from:socket.id,candidate})});
 socket.on('disconnect',()=>{const idx=voiceQueue.indexOf(socket.id);if(idx>=0)voiceQueue.splice(idx,1);const peer=socket.peerId;if(peer){const ps=io.sockets.sockets.get(peer);if(ps){ps.peerId=null;ps.emit('voice:ended')}}sockets.delete(socket.id);io.emit('presence',onlinePayload())});
});

app.get('*',(req,res)=>res.sendFile(path.join(__dirname,'public/index.html')));
const port=Number(process.env.PORT||8080);server.listen(port,()=>console.log(`HOHOGAMES Silver Chat running on http://localhost:${port}`));
