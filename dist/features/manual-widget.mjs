export const MANUAL_HTML=`
<p class="lead">像围棋一样吃子，像五子棋一样连线。<br><strong>默认只算对角线，五连要守满后续 4 手。</strong></p>
<h3>软件与网页功能说明</h3>
<ul>
  <li><b>本地双人 &amp; 人机练习</b>：支持 9 / 13 / 15 / 19 路与可调延迟；选色后统一以<b>执黑 / 执白</b>显示，不区分昵称。人机提供简单、标准、困难三档——在默认 9 路对角线延迟 4 手规则下，困难档启用离线 <b>Gen-3 NNUE 神经网络 + 多核并行（Lazy SMP）+ 160MB 共享缓存</b>，支持满载多核、极限满载（含后台预算）与标准单核切换，并提供思考进度条与局势优势条。</li>
  <li><b>好友在线对战</b>（网页版）：无需注册或填写昵称，创建 8 位房间码分享即下；同一房间支持<b>连续多局对战</b>（终局后点击“再来一局”，胜负/和棋后自动轮换摆局与选色，累计战绩与往局棋谱自动保存），附带本手与累计思考计时、本地历史席位管理与一键复制房间码。</li>
  <li><b>棋谱库、复盘与 AI 续下</b>：支持一键保存本地或在线对局到本机棋谱库，以及导入/导出 JSON 棋谱文件；可在“棋谱库与复盘”页面<b>一步一步复盘</b>、点击着法列表任意步跳转、在<b>任意局面为黑白双方分别生成 AI 建议</b>，或点击“从此处开练”直接以执黑、执白对 AI 或双人续下。</li>
  <li><b>桌面客户端与快捷键</b>：Windows 桌面版完全离线运行（自动存档于 <code>%APPDATA%\\QiLine</code>），记忆窗口尺寸与位置，支持任务栏闪烁与落子音效提醒；常用快捷键：<b>方向键</b>移动、<b>Enter/空格</b>落子、<b>I</b> 查气、<b>L</b> 手数、<b>P</b> 停手、<b>Z</b> 悔棋。</li>
</ul>
<h3>01 · 开局与三手换色</h3>
<p>默认规则下，由<b>摆局方（A）</b>连续摆黑、白、黑三子（均不能提子）；<b>选色方（B）</b>看过布局后选择<b>执黑</b>或<b>执白</b>，之后由<b>执白</b>先行。若关闭三手换色，则执黑直接先行。</p>
<h3>02 · 提子与禁着点</h3>
<p>同色棋子按上下左右连接成块；棋块相邻空点称为“气”。落子先提走无气的对方棋块，再检查己方是否有气；自杀手、重复历史棋盘（全局禁重复）及摆局提子都会在悬停时标灰提示并阻止落子。</p>
<div class="diagram-pair"><figure><svg viewBox="0 0 160 160" role="img" aria-label="白子E5仅剩F5一口气，黑下F5即可提子"><path d="M30 20v120M80 20v120M130 20v120M20 30h120M20 80h120M20 130h120"/><circle cx="80" cy="80" r="18" class="diagram-white"/><circle cx="80" cy="30" r="18"/><circle cx="30" cy="80" r="18"/><circle cx="80" cy="130" r="18"/><circle cx="130" cy="80" r="10" class="diagram-liberty"/></svg><figcaption>白子只剩右侧一口气<br>黑下此处，即可提白。</figcaption></figure><figure><svg viewBox="0 0 160 160" role="img" aria-label="A1到E5的对角五连"><path d="M20 20h120v120H20zM50 20v120M80 20v120M110 20v120M20 50h120M20 80h120M20 110h120"/><path d="M20 140 140 20" class="diagram-line"/><circle cx="20" cy="140" r="12"/><circle cx="50" cy="110" r="12"/><circle cx="80" cy="80" r="12"/><circle cx="110" cy="50" r="12"/><circle cx="140" cy="20" r="12"/></svg><figcaption>对角线上连续五子<br>保持到倒计时结束获胜。</figcaption></figure></div>
<h3>03 · 五连延迟确认</h3>
<p>默认任一对角线连续五子后形成候选（当手不计入延迟），随后双方累计再行满 <b>4 手</b>且原五子仍在盘，即确认获胜。落子与停手都计手，查气、选色与申请操作不计手。固定五子模式下每组独立计时；开启“换线继承”后，同色只要保持五连存在即可接替原倒计时。</p>
<h3>04 · 停手、悔棋与存档</h3>
<p>无五连候选时双方连续停手判和；有候选时停手不中断倒计时。本地双人休闲模式及在线房间支持双方同意后一次撤回两手（选色也计一手）；人机练习可随时单步/成对悔棋。自动保存与导出均基于规则引擎全盘校验回放，保证棋谱合法可靠。</p>
<h3>可调整的设置</h3>
<table><tbody><tr><th>棋盘</th><td>9 / 13 / 15 / 19 路（支持棋盘缩放适配）</td></tr><tr><th>延迟</th><td>0 / 2 / 4 / 6 / 8 / 10 / 12 手</td></tr><tr><th>方向</th><td>仅对角线 / 四方向</td></tr><tr><th>可开关</th><td>三手换色、全局禁重复、换线继承、竞技模式</td></tr></tbody></table>`;

export function installCornerManual(){
  if(typeof document==='undefined'||!document.body)return null;
  let dialog=document.getElementById('manual-dialog');
  if(!dialog){
    dialog=document.createElement('dialog');
    dialog.id='manual-dialog';
    dialog.setAttribute('aria-labelledby','manual-title');
    dialog.innerHTML=`<div class="dialog-head"><div><p class="eyebrow">HOW TO PLAY &amp; GUIDE</p><h2 id="manual-title">玩法手册与功能指南</h2></div><button type="button" id="shared-manual-close" class="close-btn" aria-label="关闭手册">×</button></div><article class="manual">${MANUAL_HTML}</article>`;
    document.body.append(dialog);
    dialog.querySelector('#shared-manual-close')?.addEventListener('click',()=>dialog.close());
  }else{
    const article=dialog.querySelector('article.manual');
    if(article)article.innerHTML=MANUAL_HTML;
  }
  const open=()=>dialog.showModal?.();
  for(const btn of document.querySelectorAll('#manual-open,#rules-details,#corner-manual-fab,[data-open-manual]')){
    btn.addEventListener('click',open);
  }
  try{
    let fab=null;try{fab=document.getElementById('corner-manual-fab');}catch{}
    if(!fab&&typeof document.querySelectorAll==='function'){
      fab=document.createElement('button');
      fab.type='button';
      fab.id='corner-manual-fab';
      fab.className='corner-manual-fab';
      fab.setAttribute('aria-label','打开玩法手册');
      fab.textContent='？玩法手册';
      fab.addEventListener('click',open);
      document.body.append(fab);
    }else{
      fab?.addEventListener?.('click',open);
    }
  }catch{}
  return dialog;
}
