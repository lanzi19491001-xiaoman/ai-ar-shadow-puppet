// AI+AR 皮影小剧场 · 手势隔空操控模块
// 依赖：MediaPipe HandLandmarker（自托管 vision_bundle.mjs + wasm + 模型）
// 手势：张开手掌 → 隔空"提线"操控角色组跟随移动；握拳 → 定身（暂停动画）
// 原则：任何失败都不影响原有 MindAR AR 功能（静默降级）

import { FilesetResolver, HandLandmarker } from './vision_bundle.mjs';

(function(){
  'use strict';
  var running = false, handLandmarker = null, lastVideoTime = -1;
  var currentGesture = 'none', handValid = false, handX = 0.5, handY = 0.5;
  var troupe = null, wuAnimEl = null, tiAnimEl = null, gestureTxt = null;

  function $(id){ return document.getElementById(id); }
  function log(m){ console.log('[gesture]', m); }

  // 手部 21 关键点（MediaPipe Hands 标准索引）
  // 0=腕部, 4=拇指尖, 8=食指尖, 12=中指尖, 16=无名指尖, 20=小指尖, 9=中指根
  function classify(lm){
    var w = lm[0], mcp = lm[9];
    var palm = Math.sqrt(Math.pow(mcp.x-w.x,2)+Math.pow(mcp.y-w.y,2)) || 1e-6;
    var tips = [8,12,16,20], ext = 0, i;
    for(i=0;i<tips.length;i++){
      var t = lm[tips[i]];
      if(Math.sqrt(Math.pow(t.x-w.x,2)+Math.pow(t.y-w.y,2))/palm > 2.05) ext++;
    }
    if(ext >= 3) return 'open';   // 至少三指伸直 → 张开手掌
    if(ext <= 1) return 'fist';   // 指尖收拢 → 握拳
    return 'none';
  }

  function setHint(t){ if(gestureTxt) gestureTxt.textContent = t; }

  function pauseAnims(){
    if(wuAnimEl && wuAnimEl.components && wuAnimEl.components.animation) wuAnimEl.components.animation.pause();
    if(tiAnimEl && tiAnimEl.components && tiAnimEl.components.animation) tiAnimEl.components.animation.pause();
  }
  function resumeAnims(){
    if(wuAnimEl && wuAnimEl.components && wuAnimEl.components.animation) wuAnimEl.components.animation.play();
    if(tiAnimEl && tiAnimEl.components && tiAnimEl.components.animation) tiAnimEl.components.animation.play();
  }

  // 驱动角色组（#troupe 整体平移；武松/老虎的相对对打动画保留在组内）
  function drive(){
    if(!running) return;
    if(!troupe){
      troupe = document.getElementById('troupe');
      if(troupe){
        wuAnimEl = troupe.querySelector('a-image[src="#wusong"] a-animation');
        tiAnimEl = troupe.querySelector('a-image[src="#tiger"] a-animation');
      }
    }
    if(troupe){
      var p = troupe.getAttribute('position') || {x:0,y:0,z:0};
      if(handValid && currentGesture === 'open'){
        // 手归一化坐标 → 舞台坐标：x 左右平移，y 抬升（提线感：手抬角色升）
        // 钳制在幕布范围内（x ±0.35、y 0.02~0.30），避免角色被移出舞台/沉入海报平面
        var tx = Math.max(-0.35, Math.min(0.35, (handX - 0.5) * 0.9));
        var ty = Math.max(0.02, Math.min(0.30, (0.5 - handY) * 0.5 + 0.02));
        p.x += (tx - p.x) * 0.25;
        p.y += (ty - p.y) * 0.25;
        troupe.setAttribute('position', p);
        resumeAnims();
        setHint('张开手掌 · 操控中');
      } else if(currentGesture === 'fist'){
        pauseAnims();
        setHint('握拳 · 定身');
      } else {
        resumeAnims();
        p.x += (0 - p.x) * 0.06;
        p.y += (0.02 - p.y) * 0.06;
        troupe.setAttribute('position', p);
        setHint(handValid ? '手势识别中' : '张开手掌操控 · 握拳定身');
      }
    }
    requestAnimationFrame(drive);
  }

  // 逐帧检测：仅当视频有新帧时推理，控制 CPU 占用
  function detectLoop(video){
    if(!running) return;
    if(video.readyState >= 2 && video.currentTime !== lastVideoTime){
      lastVideoTime = video.currentTime;
      try{
        var res = handLandmarker.detectForVideo(video, performance.now());
        if(res.landmarks && res.landmarks.length > 0){
          var lm = res.landmarks[0];
          currentGesture = classify(lm);
          handX = (lm[0].x + lm[9].x) / 2;
          handY = (lm[0].y + lm[9].y) / 2;
          handValid = true;
        } else {
          currentGesture = 'none'; handValid = false;
        }
      }catch(e){ /* 单帧失败跳过 */ }
    }
    requestAnimationFrame(function(){ detectLoop(video); });
  }

  async function init(){
    gestureTxt = $('gestureTxt');
    try{
      // 传 wasm 所在目录路径（MediaPipe 会按 SIMD 支持自动选择 vision_wasm_internal.js 或 nosimd 版）
      var fileset = await FilesetResolver.forVisionTasks('./js/');
      var opts = {
        baseOptions: { modelAssetPath: './js/hand_landmarker.task', delegate: 'GPU' },
        runningMode: 'VIDEO',
        numHands: 1
      };
      try{
        handLandmarker = await HandLandmarker.createFromOptions(fileset, opts);
      }catch(e){
        log('GPU 推理不可用，降级 CPU');
        opts.baseOptions.delegate = 'CPU';
        handLandmarker = await HandLandmarker.createFromOptions(fileset, opts);
      }
    }catch(e){
      log('手势引擎初始化失败：' + e.message);
      setHint('手势识别不可用');
      return;
    }
    log('手势引擎就绪');

    // 等待可用视频源：优先复用 MindAR 已启动的摄像头流
    var video = null, tries = 0;
    while(tries < 80){
      video = document.querySelector('video');
      if(video && video.readyState >= 2) break;
      await new Promise(function(r){ setTimeout(r, 250); });
      tries++;
    }
    if(!video || video.readyState < 2){
      log('未发现现有视频流，尝试自建后置摄像头流');
      try{
        var v = document.createElement('video');
        v.style.cssText = 'position:fixed;width:2px;height:2px;opacity:0;left:-10px;top:-10px;pointer-events:none;';
        document.body.appendChild(v);
        v.srcObject = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
        await v.play();
        video = v;
      }catch(e){
        log('自建视频流失败：' + e.message);
        setHint('手势识别不可用');
        return;
      }
    }
    running = true;
    setHint('张开手掌操控 · 握拳定身');
    requestAnimationFrame(function(){ detectLoop(video); });
    requestAnimationFrame(drive);
  }

  // 等待 A-Frame / MindAR 启动后再初始化手势引擎
  var afTries = 0;
  (function waitAR(){
    if(window.AFRAME || afTries > 30){ init(); }
    else { afTries++; setTimeout(waitAR, 200); }
  })();
})();
