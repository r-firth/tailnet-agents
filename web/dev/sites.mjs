// Simulated websites for the mock server. They are "real" pages rendered by a
// headless Chromium, so the Desk shows genuine screencast frames. Each page
// exposes window.show(state, data) so the scripted agent can move through it,
// plus window.__fam.* which mimics the small overlay agentd injects (the agent
// cursor and the element it is acting on).

const overlay = `
<style>
#__fam_hl{position:fixed;pointer-events:none;border:2px solid #ff6a2b;border-radius:8px;box-shadow:0 0 0 4px rgba(255,106,43,.25);transition:all .35s cubic-bezier(.3,.7,.2,1);z-index:99998;display:none}
#__fam_hl.dash{border-style:dashed;box-shadow:none}
#__fam_hl span{position:absolute;left:-2px;top:-24px;white-space:nowrap;font:600 12px/20px ui-monospace,"DejaVu Sans Mono",monospace;color:#fff;background:#ff6a2b;padding:0 7px;border-radius:4px}
#__fam_cur{position:fixed;pointer-events:none;z-index:99999;transition:left .6s cubic-bezier(.3,.7,.2,1),top .6s cubic-bezier(.3,.7,.2,1);display:none}
#__fam_cur b{position:absolute;left:19px;top:19px;font:600 11px/18px "Liberation Sans",Arial,sans-serif;background:#ff6a2b;color:#fff;padding:0 7px;border-radius:9px;white-space:nowrap}
#__you_cur{position:fixed;pointer-events:none;z-index:99999;display:none}
</style>
<div id="__fam_hl"><span></span></div>
<div id="__fam_cur"><svg width="20" height="24" viewBox="0 0 22 26"><path d="M2 2 L2 21 L7.2 16.4 L10.6 24 L14 22.5 L10.7 15.1 L18 14.6 Z" fill="#ff6a2b" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/></svg><b>Claude</b></div>
<div id="__you_cur"><svg width="20" height="24" viewBox="0 0 22 26"><path d="M2 2 L2 21 L7.2 16.4 L10.6 24 L14 22.5 L10.7 15.1 L18 14.6 Z" fill="#3b6fe0" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/></svg></div>
<script>
window.__fam = {
  focus(sel, label, dashed, who){
    const hl=document.getElementById('__fam_hl'), cur=document.getElementById('__fam_cur');
    const el=sel?document.querySelector(sel):null;
    if(!el){hl.style.display='none';cur.style.display='none';return false}
    const r=el.getBoundingClientRect();
    hl.style.display='block';hl.className=dashed?'dash':'';
    hl.style.left=(r.left-5)+'px';hl.style.top=(r.top-4)+'px';hl.style.width=(r.width+10)+'px';hl.style.height=(r.height+8)+'px';
    hl.firstElementChild.textContent=label||'';hl.firstElementChild.style.display=label?'block':'none';
    if(r.top<40){hl.firstElementChild.style.top='auto';hl.firstElementChild.style.bottom='-24px'}else{hl.firstElementChild.style.top='-24px';hl.firstElementChild.style.bottom='auto'}
    cur.style.display='block';cur.style.left=(r.left+Math.min(r.width*.62,r.width-8))+'px';cur.style.top=(r.top+r.height*.6)+'px';
    if(who) cur.querySelector('b').textContent=who;
    return true;
  },
  clear(){document.getElementById('__fam_hl').style.display='none';document.getElementById('__fam_cur').style.display='none'},
  you(x,y){const c=document.getElementById('__you_cur');c.style.display='block';c.style.left=(x-2)+'px';c.style.top=(y-2)+'px';this.clear()},
};
</script>`;

const base = (body, css, script = '') => `<!doctype html><html><head><meta charset="utf-8"><style>
*{box-sizing:border-box}html,body{margin:0;height:100%}body{font:14px/1.45 "Liberation Sans",Arial,Helvetica,sans-serif;-webkit-font-smoothing:antialiased}
${css}</style></head><body>${body}${overlay}<script>${script}</script></body></html>`;

// ---------------------------------------------------------------- meshy
export const meshy = base(`
<div class="top"><div class="logo"><i></i>meshy</div><nav><span>Workspace</span><span>Community</span><span>Pricing</span><span>API</span></nav>
<div class="r"><span>1,240 credits</span><span class="pro" id="pro">PRO</span><span class="av">R</span></div></div>
<div class="body"><aside class="side" id="side"></aside><main class="main" id="main"></main></div>
<div class="shade" id="shade"></div><div class="modal" id="modal"></div>
<div class="toast" id="toast"></div>`, `
body{background:#0f1116;color:#e7e9ee;overflow:hidden}
.top{height:52px;display:flex;align-items:center;gap:26px;padding:0 22px;border-bottom:1px solid #22262f}
.logo{display:flex;align-items:center;gap:9px;font-size:19px;font-weight:700;letter-spacing:-.02em}
.logo i{width:20px;height:20px;border-radius:6px;background:linear-gradient(135deg,#d4f55c,#7fd34e)}
nav{display:flex;gap:22px;color:#9aa1ad;font-size:14px}
.r{margin-left:auto;display:flex;align-items:center;gap:14px;font-size:13px;color:#9aa1ad}
.pro{font-weight:700;font-size:11px;color:#0f1116;background:#cdf25b;padding:3px 8px;border-radius:5px}
.pro.free{background:#3b4252;color:#cfd4dc}
.av{width:30px;height:30px;border-radius:50%;background:#3b4252;color:#fff;display:flex;align-items:center;justify-content:center;font-weight:600}
.body{display:grid;grid-template-columns:200px 1fr;height:calc(100% - 52px)}
.side{border-right:1px solid #22262f;padding:16px 12px;display:flex;flex-direction:column;gap:2px}
.side .h{font-size:11px;color:#6c7380;letter-spacing:.06em;text-transform:uppercase;padding:12px 10px 5px}
.side span{padding:8px 11px;border-radius:7px;color:#b3b9c4;font-size:14px}
.side span.a{background:#1c2029;color:#fff}
.main{padding:22px 28px;position:relative;overflow:hidden}
h2{margin:0;font-size:26px;letter-spacing:-.02em;font-weight:600}
.sub{color:#8b919c;font-size:13.5px;margin-top:3px}
.chips{display:flex;gap:8px;margin:14px 0 16px}.chips span{font-size:13px;padding:6px 12px;border-radius:15px;border:1px solid #2a2f3a;color:#b3b9c4}.chips span.a{background:#e7e9ee;color:#0f1116;border-color:#e7e9ee}
.grid{display:grid;grid-template-columns:repeat(4,1fr);gap:14px}
.card{border-radius:12px;background:#161a22;border:1px solid #232834;overflow:hidden}
.th{height:120px;position:relative;background:radial-gradient(120% 90% at 50% 100%,#232a36,#171b23)}
.th i{position:absolute;left:50%;top:52%;transform:translate(-50%,-50%)}
.card p{margin:0;padding:8px 12px 0;font-size:14px;font-weight:600}.card small{display:block;padding:0 12px 10px;color:#7b8290;font-size:12px}
.s1{width:70px;height:70px;border-radius:50%;background:radial-gradient(circle at 35% 30%,#ffd29a,#e2803e 55%,#7a3a17)}
.s2{width:58px;height:58px;border-radius:8px;background:linear-gradient(135deg,#9fb4c9,#4f6377);transform:translate(-50%,-50%) rotate(45deg)!important}
.s3{width:90px;height:56px;border-radius:50% 50% 45% 45%;background:radial-gradient(circle at 40% 30%,#f3f1ec,#b9b3a8 60%,#6e6960)}
.s4{width:18px;height:78px;border-radius:8px;background:linear-gradient(#e8d9a8,#8c7a45);box-shadow:26px -24px 0 -2px #e8d9a8}
.s5{width:84px;height:58px;border-radius:48% 52% 40% 44%;background:radial-gradient(circle at 40% 30%,#8fbf6a,#4a6e36 60%,#26361c)}
.s6{width:58px;height:66px;border-radius:40% 40% 20% 20%;background:linear-gradient(#c7ccd6,#6f7684)}
.s7{width:72px;height:44px;border-radius:6px;background:linear-gradient(#c98f5a,#7a4d2a);box-shadow:0 20px 0 -13px #5a381e}
.s8{width:24px;height:70px;border-radius:12px;background:linear-gradient(90deg,#8a6a2a,#e2c26b,#8a6a2a)}
.bill{display:grid;grid-template-columns:1.4fr 1fr;gap:16px;margin-top:18px}
.box{border-radius:14px;background:#161a22;border:1px solid #232834;padding:18px 20px}
.lab{font-size:11.5px;color:#7b8290;letter-spacing:.06em;text-transform:uppercase}
.plan{display:flex;align-items:baseline;gap:12px;margin-top:8px}.plan b{font-size:34px;letter-spacing:-.02em}.plan span{font-size:17px;color:#c5cad3}
.ren{font-size:14px;color:#b3b9c4;margin-top:6px}.ren strong{color:#fff;font-weight:600}
.btns{display:flex;gap:10px;margin-top:16px}
.b{white-space:nowrap;font-size:14px;font-weight:600;padding:10px 16px;border-radius:9px;border:1px solid #2e3440;color:#e7e9ee;background:none;cursor:pointer;font-family:inherit}
.b.pri{background:#cdf25b;color:#0f1116;border-color:#cdf25b}.b.dang{color:#ff8a80;border-color:#4a2a2a}.b.txt{border-color:transparent;color:#aab0bb;font-weight:500}
.visa{width:48px;height:30px;border-radius:5px;background:linear-gradient(135deg,#2c3a8c,#1a2260);color:#fff;font:700 11px/30px Arial,sans-serif;text-align:center;letter-spacing:.04em;flex:none}
.card2{display:flex;align-items:center;gap:14px;margin-top:12px}
.inv{grid-column:1/-1}.inv .r2{display:grid;grid-template-columns:1fr 1fr 100px 80px;font-size:14px;padding:8px 0;border-top:1px solid #222733;color:#b3b9c4}.inv .r2:first-of-type{border-top:0}.ok{color:#8fd48a}
.shade{position:fixed;inset:0;background:rgba(5,6,9,.62);display:none}
.modal{position:fixed;left:calc(50% - 220px + 100px);top:150px;width:440px;border-radius:16px;background:#171b24;border:1px solid #2c3240;padding:26px 28px;box-shadow:0 30px 60px rgba(0,0,0,.5);display:none}
.eyebrow{font-size:13px;color:#cdf25b;font-weight:600}.modal h3{margin:6px 0 8px;font-size:24px;letter-spacing:-.02em}.modal p{margin:0;color:#aab0bb;font-size:14px}
.col{display:flex;flex-direction:column;gap:9px;margin-top:20px}.col .b{text-align:center}
.spin{width:34px;height:34px;border-radius:50%;border:3px solid #2c3240;border-top-color:#cdf25b;animation:spin .9s linear infinite;margin:4px auto 16px}
@keyframes spin{to{transform:rotate(360deg)}}
.banner{display:flex;gap:12px;align-items:center;padding:12px 16px;border-radius:12px;background:#15241a;border:1px solid #24472f;color:#bfe8c8;font-size:14px;margin-top:16px}
.banner b{color:#fff}
.toast{position:fixed;right:24px;bottom:24px;padding:12px 16px;border-radius:10px;background:#e7e9ee;color:#0f1116;font-weight:600;font-size:14px;display:none}
`, `
const MODELS=[['s1','Low-poly fox','2 days ago'],['s2','Sci-fi crate','3 days ago'],['s3','Ceramic teapot','5 days ago'],['s4','Desk lamp','1 week ago'],['s5','Moss boulder','1 week ago'],['s6','Robot bust','2 weeks ago'],['s7','Oak stool','2 weeks ago'],['s8','Brass key','3 weeks ago']];
const $=id=>document.getElementById(id);
function side(which){
  $('side').innerHTML = which==='dash'
   ? '<span>Home</span><span class="a">My assets</span><span>Text to 3D</span><span>Image to 3D</span><span>Texturing</span><div class="h">Account</div><span id="nav-settings">Settings</span><span>Help</span>'
   : '<div class="h">Settings</div><span>Profile</span><span class="a" id="nav-billing">Billing</span><span>API keys</span><span>Notifications</span><span>Connected apps</span>';
}
function billing(cancelled){
  return '<h2>Billing</h2><div class="sub">Manage your plan, payment method and invoices</div>'+
  (cancelled?'<div class="banner" id="banner"><b>Subscription cancelled.</b> Pro stays active until 14 Oct 2026, then your workspace moves to Free.</div>':'')+
  '<div class="bill"><div class="box" id="plan"><div class="lab">Current plan</div><div class="plan"><b>Pro</b><span>£16 / month</span></div>'+
  (cancelled?'<div class="ren" id="ends">Ends on <strong>14 Oct 2026</strong> · will not renew</div><div class="btns"><button class="b pri">Resume Pro</button></div>'
  :'<div class="ren">Renews on <strong>14 Oct 2026</strong></div><div class="btns"><button class="b pri">Change plan</button><button class="b dang" id="cancel">Cancel subscription</button></div>')+
  '</div><div class="box"><div class="lab">Payment method</div><div class="card2"><span class="visa">VISA</span><div><div style="font-weight:600">Visa •••• 4242</div><div style="font-size:13px;color:#8b919c">Expires 08/28</div></div></div><div class="ren" style="margin-top:16px">Billing email r•••@gmail.com</div></div>'+
  '<div class="box inv"><div class="lab" style="margin-bottom:6px">Invoices</div>'+
  '<div class="r2"><span>14 Sep 2026</span><span>Pro, monthly</span><span>£16.00</span><span class="ok">Paid</span></div>'+
  '<div class="r2"><span>14 Aug 2026</span><span>Pro, monthly</span><span>£16.00</span><span class="ok">Paid</span></div>'+
  '<div class="r2"><span>14 Jul 2026</span><span>Pro, monthly</span><span>£16.00</span><span class="ok">Paid</span></div></div></div>';
}
function modal(html){ $('shade').style.display=html?'block':'none'; $('modal').style.display=html?'block':'none'; $('modal').innerHTML=html||''; }
window.show=function(state){
  window.__fam.clear();
  if(state==='dash'){ side('dash'); modal(null); $('main').innerHTML='<h2>My assets</h2><div class="sub">42 models · signed in as Ryan (Google)</div><div class="chips"><span class="a">All</span><span>Text to 3D</span><span>Image to 3D</span><span>Favourites</span></div><div class="grid">'+MODELS.map(m=>'<div class="card"><div class="th"><i class="'+m[0]+'"></i></div><p>'+m[1]+'</p><small>'+m[2]+'</small></div>').join('')+'</div>'; }
  else if(state==='billing'){ side('bill'); modal(null); $('main').innerHTML=billing(false); }
  else if(state==='offer'){ side('bill'); $('main').innerHTML=billing(false); modal('<div class="eyebrow">Before you go</div><h3>50% off your next 3 months</h3><p>Keep Pro for £8/month until January. You can cancel any time.</p><div class="col"><button class="b pri">Claim 50% off</button><button class="b txt" id="nothanks">No thanks, cancel</button></div>'); }
  else if(state==='confirm'){ side('bill'); $('main').innerHTML=billing(false); modal('<div style="text-align:center"><div class="spin"></div><div id="wait"><h3 style="margin-top:0">Cancelling your subscription</h3><p>This can take a few seconds. Please don\\'t close this page.</p></div></div>'); }
  else if(state==='cancelled'){ side('bill'); modal(null); $('main').innerHTML=billing(true); $('pro').textContent='PRO'; }
};
show('dash');
`);

// ---------------------------------------------------------------- lner
export const lner = base(`
<div class="top"><b class="lg">LN<span>E</span>R</b><span>Tickets</span><span>Journeys</span><span>Help</span><span class="r">Ryan F.</span></div>
<div class="steps" id="steps"></div><div class="body" id="body"></div>`, `
body{background:#f5f4f1;color:#1d1f24}
.top{height:58px;background:#1e2230;color:#fff;display:flex;align-items:center;gap:28px;padding:0 30px;font-size:14px}
.lg{font-size:21px;letter-spacing:.04em;font-weight:800}.lg span{color:#e4344b}.r{margin-left:auto;color:#c8ccd6}
.steps{display:flex;gap:30px;padding:13px 30px;font-size:13.5px;color:#777;border-bottom:1px solid #e3e1dc;background:#fff}.steps .a{color:#1d1f24;font-weight:700}.steps .d{color:#1f8f57}
.body{display:grid;grid-template-columns:1.3fr 1fr;gap:20px;padding:24px 30px}
h2{grid-column:1/-1;margin:0;font-size:28px;letter-spacing:-.02em}
.card{background:#fff;border:1px solid #e3e1dc;border-radius:12px;padding:22px 24px}
.lab{font-size:11.5px;color:#888;letter-spacing:.06em;text-transform:uppercase}
.j{display:grid;grid-template-columns:auto 1fr auto;gap:4px 16px;align-items:center;margin-top:12px}.j b{font-size:26px}.j span{font-size:15px}.line{height:2px;background:#d6d3cc}
.meta{margin-top:14px;font-size:14px;color:#555;line-height:1.7}
.tot{display:flex;justify-content:space-between;align-items:baseline;margin-top:8px}.tot b{font-size:34px;letter-spacing:-.02em}
.pay{margin-top:16px;display:block;width:100%;text-align:center;background:#c8102e;color:#fff;font-weight:700;font-size:16px;padding:14px;border-radius:9px;border:0;font-family:inherit}
.pay.proc{background:#1f8f57}
.vis{display:flex;gap:10px;align-items:center;margin-top:14px;font-size:14px}
.visa{width:44px;height:28px;border-radius:5px;background:linear-gradient(135deg,#2c3a8c,#1a2260);color:#fff;font:700 10px/28px Arial,sans-serif;text-align:center}
.okc{grid-column:1/-1;display:flex;gap:18px;align-items:center;background:#eef8f1;border:1px solid #bfe3cb;border-radius:12px;padding:20px 24px}
.okc .t{width:44px;height:44px;border-radius:50%;background:#1f8f57;color:#fff;display:flex;align-items:center;justify-content:center;font-size:24px;font-weight:700}
.okc h3{margin:0;font-size:22px}.okc p{margin:2px 0 0;color:#476553}
.qr{width:120px;height:120px;background:repeating-conic-gradient(#1d1f24 0 25%,#fff 0 50%) 0 0/12px 12px;border:8px solid #fff;outline:1px solid #ddd}
`, `
const $=id=>document.getElementById(id);
const journey='<div class="card"><div class="lab">Outward · Friday 17 October 2026</div><div class="j"><b>08:00</b><div class="line"></div><b>12:20</b><span>London Kings Cross</span><span></span><span>Edinburgh</span></div><div class="meta">Direct · 4h 20m · Advance Single<br>Coach C · Seat 42A · Window, forward facing</div></div>';
window.show=function(state){
  window.__fam.clear();
  if(state==='review'||state==='processing'){
    $('steps').innerHTML='<span class="d">1 Journey ✓</span><span class="d">2 Seats ✓</span><span class="a">3 Review and pay</span><span>4 Tickets</span>';
    $('body').innerHTML='<h2>Review and pay</h2>'+journey+'<div class="card"><div class="lab">Total to pay</div><div class="tot"><b>£142.40</b><span style="font-size:13px;color:#777">incl. £1.50 booking fee</span></div><div class="vis"><span class="visa">VISA</span>Visa •••• 4242</div><button class="pay '+(state==='processing'?'proc':'')+'" id="pay">'+(state==='processing'?'Processing payment…':'Pay £142.40')+'</button></div>';
  } else if(state==='done'){
    $('steps').innerHTML='<span class="d">1 Journey ✓</span><span class="d">2 Seats ✓</span><span class="d">3 Review and pay ✓</span><span class="a">4 Tickets</span>';
    $('body').innerHTML='<div class="okc" id="ok"><span class="t">✓</span><div><h3>Booking confirmed · LNER7Q2K9</h3><p>£142.40 paid with Visa •••• 4242 · e-ticket sent to r•••@gmail.com</p></div></div>'+journey+'<div class="card"><div class="lab">Your e-ticket</div><div style="display:flex;gap:18px;align-items:center;margin-top:12px"><div class="qr"></div><div class="meta" style="margin:0">Ref LNER7Q2K9<br>Coach C · 42A<br>Valid on 08:00 only</div></div></div>';
  }
};
show('review');
`);

// ---------------------------------------------------------------- blender installer on a Windows desktop
export const blender = base(`
<div class="win"><div class="tb">Blender Setup<span class="w"><i></i><i></i><i></i></span></div>
<div class="c"><div class="sideb"><i></i></div><div class="m" id="m"></div></div></div>
<div class="task"><i></i><i class="o"></i><i></i><i></i><span class="clk" id="clk">21:03<br>30/09/2026</span></div>`, `
body{background:linear-gradient(160deg,#35546a,#1c2f3e 60%,#15222d);overflow:hidden}
.win{position:absolute;left:calc(50% - 330px);top:70px;width:660px;height:400px;background:#f3f3f3;border-radius:8px;box-shadow:0 30px 60px rgba(0,0,0,.45);overflow:hidden;color:#1d1d1d;font-family:"Liberation Sans",Arial,sans-serif}
.tb{height:36px;display:flex;align-items:center;padding:0 14px;font-size:13px;background:#fff;border-bottom:1px solid #e1e1e1}
.tb .w{margin-left:auto;display:flex;gap:22px}.tb .w i{width:10px;height:10px;border:1.5px solid #666;border-radius:1px}.tb .w i:first-child{border-width:0 0 1.5px;border-radius:0}
.c{display:grid;grid-template-columns:170px 1fr;height:364px}
.sideb{background:linear-gradient(#e87d0d,#b4540a);position:relative}
.sideb i{position:absolute;left:50%;top:44%;width:84px;height:84px;border-radius:50%;border:13px solid #fff;transform:translate(-50%,-50%)}
.sideb i::after{content:"";position:absolute;left:14px;top:14px;width:30px;height:30px;border-radius:50%;background:#265787}
.m{padding:22px 28px;position:relative}
h2{margin:0 0 4px;font-size:21px;font-weight:600}p{margin:0 0 18px;color:#555;font-size:13.5px}
.opt{display:grid;grid-template-columns:18px 1fr;gap:4px 10px;padding:12px 14px;border:1px solid #d6d6d6;border-radius:6px;margin-bottom:9px;background:#fff}
.opt i{width:15px;height:15px;border-radius:50%;border:1.5px solid #888;margin-top:2px}.opt.on{border-color:#e87d0d}.opt.on i{border:4px solid #e87d0d}
.opt b{font-size:15px}.opt span{grid-column:2;font-size:12.5px;color:#666}
.btns{position:absolute;right:28px;bottom:20px;display:flex;gap:8px}.btns span{font-size:13px;padding:7px 18px;border:1px solid #c9c9c9;border-radius:5px;background:#fdfdfd}.btns .dis{color:#aaa}.btns .go{background:#e87d0d;color:#fff;border-color:#e87d0d}
.pb{height:9px;border-radius:5px;background:#ddd;overflow:hidden;margin:16px 0 8px}.pb span{display:block;height:100%;background:#e87d0d;transition:width .4s}
.task{position:absolute;left:0;right:0;bottom:0;height:44px;background:rgba(20,26,34,.92);display:flex;align-items:center;gap:12px;padding:0 16px;color:#dfe5ea;font-size:12.5px}
.task i{width:20px;height:20px;border-radius:4px;background:#5b7a93}.task i.o{background:#e87d0d}.clk{margin-left:auto;text-align:right;line-height:1.25}
`, `
const $=id=>document.getElementById(id);
window.show=function(state,d){
  window.__fam.clear();
  d=d||{};
  if(state==='pick') $('m').innerHTML='<h2>Choose a version</h2><p>Two releases are available for Windows x64.</p><label class="opt" id="o45"><i></i><b>Blender 4.5 LTS</b><span>Long-term support release · supported until July 2027</span></label><label class="opt" id="o46"><i></i><b>Blender 4.6</b><span>Latest release, newest features</span></label><div class="btns"><span>Back</span><span class="dis" id="next">Next</span><span>Cancel</span></div>';
  else if(state==='install') $('m').innerHTML='<h2>Installing Blender '+d.v+'</h2><p>C:\\\\Program Files\\\\Blender Foundation\\\\Blender '+d.short+'</p><div class="pb"><span style="width:'+d.pct+'%"></span></div><p style="font-size:12.5px">'+(d.pct<100?'Copying files: '+(d.file||'blender.exe')+' · '+d.pct+'%':'Completed')+'</p><div class="btns"><span>Back</span><span class="'+(d.pct<100?'dis':'go')+'">'+(d.pct<100?'Next':'Finish')+'</span><span>Cancel</span></div>';
};
setInterval(()=>{const n=new Date();$('clk').innerHTML=String(n.getHours()).padStart(2,'0')+':'+String(n.getMinutes()).padStart(2,'0')+'<br>30/09/2026'},5000);
show('pick');
`);

// ---------------------------------------------------------------- generic web (search + article), used for new tasks
export const generic = base(`
<div class="bar"><span class="lg">Search</span><div class="q" id="q"></div><span class="me">R</span></div>
<div class="wrap" id="wrap"></div>`, `
body{background:#fff;color:#202124}
.bar{height:64px;display:flex;align-items:center;gap:20px;padding:0 28px;border-bottom:1px solid #ececec}
.lg{font-size:22px;font-weight:700;color:#3a5bd9;letter-spacing:-.02em}
.q{flex:1;max-width:620px;height:42px;border:1px solid #dfe1e5;border-radius:21px;padding:0 20px;display:flex;align-items:center;font-size:15px;box-shadow:0 1px 5px rgba(32,33,36,.12)}
.me{margin-left:auto;width:32px;height:32px;border-radius:50%;background:#5b6b8c;color:#fff;display:flex;align-items:center;justify-content:center;font-weight:700}
.wrap{padding:18px 28px 0 164px;max-width:980px}
.res{margin-bottom:24px}.res .u{font-size:13px;color:#4d5156}.res a{display:block;font-size:19px;color:#1a0dab;text-decoration:none;margin:3px 0}.res p{margin:0;font-size:14px;color:#4d5156}
.cnt{font-size:13px;color:#70757a;margin-bottom:16px}
article{max-width:720px;padding-top:8px}article h1{font-size:30px;margin:0 0 6px;letter-spacing:-.02em}article .by{color:#70757a;font-size:13px;margin-bottom:18px}article p{font-size:16px;line-height:1.65;color:#333}
table{border-collapse:collapse;margin:14px 0;font-size:14px}td,th{border:1px solid #e3e3e3;padding:8px 12px;text-align:left}th{background:#f6f7f9}
`, `
const $=id=>document.getElementById(id);
window.show=function(state,d){
  window.__fam.clear(); d=d||{};
  $('q').textContent=d.q||'';
  if(state==='results'){ $('wrap').innerHTML='<div class="cnt">About 2,140,000 results (0.41 seconds)</div>'+(d.results||[]).map((r,i)=>'<div class="res" id="r'+i+'"><div class="u">'+r[0]+'</div><a>'+r[1]+'</a><p>'+r[2]+'</p></div>').join(''); }
  else if(state==='article'){ $('wrap').innerHTML='<article id="art"><h1>'+d.title+'</h1><div class="by">'+d.by+'</div>'+d.body+'</article>'; }
};
show('results',{q:'',results:[]});
`);

// ---------------------------------------------------------------- receipts for tasks finished earlier today
export const receipts = {
  hetzner: base(`<div class="hd"><b>HETZNER</b><span>Cloud Console · Invoices</span></div><div class="w"><h2>Invoices</h2>
  <table><tr><th>Date</th><th>Number</th><th>Amount</th><th></th></tr>
  <tr class="hi"><td>01 Sep 2026</td><td>R0021784512</td><td>€41.87</td><td>✓ Downloaded</td></tr>
  <tr class="hi"><td>01 Sep 2026</td><td>R0021784513</td><td>€6.50</td><td>✓ Downloaded</td></tr>
  <tr><td>01 Aug 2026</td><td>R0021533908</td><td>€41.87</td><td>PDF</td></tr><tr><td>01 Jul 2026</td><td>R0021290115</td><td>€38.12</td><td>PDF</td></tr></table>
  <div class="note">2 invoices saved to Drive › Finance › 2026-09 and forwarded to accounts@</div></div>`, `
  body{background:#f4f5f7;color:#1e2330}.hd{height:56px;background:#d50c2d;color:#fff;display:flex;align-items:center;gap:20px;padding:0 28px}.hd b{font-size:20px;letter-spacing:.08em}
  .w{padding:26px 40px}h2{margin:0 0 16px;font-size:26px}table{width:100%;border-collapse:collapse;background:#fff;border-radius:10px;overflow:hidden;font-size:15px}
  th,td{text-align:left;padding:13px 18px;border-bottom:1px solid #e6e8ec}th{font-size:12px;color:#707888;text-transform:uppercase;letter-spacing:.05em}
  tr.hi td{background:#f0fbf3}tr.hi td:last-child{color:#1f8f57;font-weight:700}.note{margin-top:18px;font-size:14px;color:#445}`),
  royalmail: base(`<div class="hd"><b>Royal Mail</b><span>Track your item</span></div><div class="w"><div class="ref">Tracking number <b>RM482291057GB</b></div>
  <h2>Delivered</h2><p>Your item was delivered on 30 Sep 2026 at 11:42 and signed for by <b>SAM</b>.</p>
  <ol><li class="d"><b>Delivered</b><span>30 Sep, 11:42 · Edinburgh EH6</span></li><li><b>Out for delivery</b><span>30 Sep, 07:05</span></li><li><b>At delivery office</b><span>29 Sep, 22:14</span></li><li><b>Posted</b><span>28 Sep, 16:30 · London N1</span></li></ol></div>`, `
  body{background:#fff;color:#222}.hd{height:60px;background:#da202a;color:#fff;display:flex;align-items:center;gap:20px;padding:0 30px}.hd b{font-size:22px}
  .w{padding:28px 44px}.ref{font-size:14px;color:#666}h2{font-size:34px;margin:10px 0 6px;color:#1f8f57}p{font-size:16px}ol{list-style:none;padding:0;margin:24px 0 0;border-left:3px solid #ddd}
  li{padding:6px 0 14px 20px;position:relative}li::before{content:"";position:absolute;left:-9px;top:10px;width:14px;height:14px;border-radius:50%;background:#ccc;border:1px solid #fff}
  li.d::before{background:#1f8f57}li b{display:block;font-size:16px}li span{font-size:14px;color:#666}`),
  dentist: base(`<div class="hd"><b>Leith Walk Dental</b><span>Online booking</span></div><div class="w"><h2>Choose a time</h2><div class="wk">
  <div><b>Mon 20 Oct</b><span class="x">No slots</span></div><div><b>Tue 21 Oct</b><span class="s on">09:40 · held for you</span><span class="s">14:10</span></div><div><b>Wed 22 Oct</b><span class="s">16:30</span></div><div><b>Thu 23 Oct</b><span class="x">No slots</span></div></div>
  <div class="note">Held until 18:00 tomorrow. Nothing is booked until you confirm.</div></div>`, `
  body{background:#f7fbfb;color:#1b2b2b}.hd{height:58px;background:#0f6e6e;color:#fff;display:flex;align-items:center;gap:20px;padding:0 30px}.hd b{font-size:20px}
  .w{padding:26px 40px}h2{margin:0 0 18px;font-size:26px}.wk{display:grid;grid-template-columns:repeat(4,1fr);gap:14px}.wk div{background:#fff;border:1px solid #d7e6e6;border-radius:10px;padding:14px;display:flex;flex-direction:column;gap:8px}
  .s{padding:9px;border:1px solid #9fcaca;border-radius:7px;text-align:center;color:#0f6e6e;font-weight:600}.s.on{background:#0f6e6e;color:#fff}.x{color:#8aa;font-size:14px}.note{margin-top:20px;color:#456;font-size:15px}`),
  backup: base(`<div class="t"><div class="l">studio · restic</div><pre>
$ restic backup D:\\Projects D:\\Assets --tag weekly
<span class="d">open repository</span>
<span class="d">using parent snapshot 7f3e21b0</span>
Files:        1284 new,  3301 changed, 88412 unmodified
Dirs:           62 new,   410 changed,  9120 unmodified
Added to the repository: 18.422 GiB (14.901 GiB stored)
<span class="g">processed 93,997 files, 612.301 GiB in 38:12</span>
<span class="g">snapshot 9ac14d52 saved</span>
$ restic forget --keep-weekly 8 --prune
<span class="d">removed 1 snapshot, freed 11.2 GiB</span>
</pre></div>`, `body{background:#0c0e11;color:#cfd6dd}.t{padding:24px 30px}.l{color:#6c7680;font:13px monospace;margin-bottom:10px}pre{font:15px/1.6 "DejaVu Sans Mono",monospace;margin:0}.d{color:#6c7680}.g{color:#8fd48a}`),
};

// ---------------------------------------------------------------- simulated remote desktop page (served as desktop_url)
export const desktopPage = (title) => `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title><style>
html,body{margin:0;height:100%;background:#111;color:#ddd;font:13px Arial,sans-serif}
.bar{height:30px;display:flex;align-items:center;gap:10px;padding:0 10px;background:#1b1e22;border-bottom:1px solid #2a2e33;font-size:12px}
.bar b{color:#fff}.bar span{color:#8a939c}.dot{width:8px;height:8px;border-radius:50%;background:#4cc38a}
iframe{border:0;width:100%;height:calc(100% - 30px);display:block}
</style></head><body><div class="bar"><span class="dot"></span><b>studio</b><span>noVNC · 2560×1440 scaled · view only until you take control</span></div>
<iframe src="/api/_mock/desktop-frame"></iframe></body></html>`;
