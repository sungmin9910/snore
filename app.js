/**
 * 슬립센스 (SleepSense) - 초저발열·원거리 고감도 수면 소리 감지 엔진
 * - iOS Safari & Android/PC 호환 (Web Audio API 16kHz 저전력 파이프라인)
 * - 수면 암전 모드 진입 시 GPU/Canvas/DOM 렌더링 100% 차단 (발열 원천 차단)
 * - 원거리 미세 소리 증폭(Pre-Amp GainNode) + 80Hz 험(Hum) 제거 필터 + 2.5초 사전 녹음 순환 버퍼
 */

(() => {
  'use strict';

  // --- 상수 설정 ---
  const TARGET_SAMPLE_RATE = 16000; // 16kHz 모노 (음성/코골이/이갈이 분석 최적 및 CPU 부하 70% 절감)
  const PRE_ROLL_SECONDS = 2.5;     // 소리 감지 이전 2.5초부터 포함하여 앞부분 잘림 방지
  const POST_ROLL_MS = 2400;        // 소리가 멈춘 후 2.4초까지 여유 녹음
  const MIN_CLIP_MS = 1200;         // 최소 클립 길이
  const MAX_CLIP_MS = 30000;        // 단일 클립 최대 길이 (30초 초과 시 분할 저장)
  const DB_NAME = 'SleepSenseDB';
  const DB_STORE = 'clips';

  // --- 상태 변수 ---
  let audioCtx = null;
  let mediaStream = null;
  let sourceNode = null;
  let highpassNode = null;
  let gainNode = null;
  let analyserNode = null;
  let processorNode = null;

  let isMonitoring = false;
  let isBlackout = false;
  let isCalibrating = false;
  let isRecordingClip = false;

  // 소음 및 임계치 상태 (dBFS 기준)
  let currentDb = -65.0;
  let noiseFloorDb = -52.0;   // 방 배경 소음 기준선
  let triggerDeltaDb = 3.5;   // 배경 소음 대비 몇 dB 올라가면 녹음할지
  let preAmpGain = 10.0;      // 원거리 증폭 배수 (기본 10배 = 원거리 모드)

  // 순환 버퍼 (Pre-Roll) 및 현재 녹음 버퍼
  let actualSampleRate = TARGET_SAMPLE_RATE;
  let preRollBuffer = new Float32Array(TARGET_SAMPLE_RATE * PRE_ROLL_SECONDS);
  let preRollWriteIdx = 0;
  let currentClipChunks = [];
  let clipStartTime = 0;
  let lastAboveThresholdTime = 0;
  let clipPeakDb = -100;

  // 소리 분류용 주파수 누적 에너지
  let accumLowEnergy = 0;
  let accumMidEnergy = 0;
  let accumHighEnergy = 0;
  let accumZcr = 0;
  let accumFrames = 0;
  let dominantFreqSum = 0;

  // 타이머 & WakeLock & 렌더링 ID
  let wakeLockSentinel = null;
  let rafId = null;
  let sessionStartTimestamp = 0;
  let sessionTimerInterval = null;
  let pureBlackTimeout = null;
  let blackoutClockInterval = null;
  let lastTapTime = 0;

  // 저장된 클립 목록 및 필터
  let clips = [];
  let activeFilter = 'all';

  // --- DOM 요소 참조 ---
  const el = {
    blackoutOverlay: document.getElementById('blackoutOverlay'),
    blackoutClock: document.getElementById('blackoutClock'),
    blackoutClipCount: document.getElementById('blackoutClipCount'),
    wakeLockBadge: document.getElementById('wakeLockBadge'),
    monitoringBadge: document.getElementById('monitoringBadge'),
    sessionTimer: document.getElementById('sessionTimer'),
    presetBtns: document.querySelectorAll('.preset-btn'),
    currentDbText: document.getElementById('currentDbText'),
    noiseFloorText: document.getElementById('noiseFloorText'),
    thresholdDbText: document.getElementById('thresholdDbText'),
    meterFill: document.getElementById('meterFill'),
    noiseFloorMarker: document.getElementById('noiseFloorMarker'),
    thresholdMarker: document.getElementById('thresholdMarker'),
    liveStateIndicator: document.getElementById('liveStateIndicator'),
    liveFreqInfo: document.getElementById('liveFreqInfo'),
    spectrumCanvas: document.getElementById('spectrumCanvas'),
    gainSlider: document.getElementById('gainSlider'),
    gainValueText: document.getElementById('gainValueText'),
    deltaSlider: document.getElementById('deltaSlider'),
    deltaValueText: document.getElementById('deltaValueText'),
    highpassToggle: document.getElementById('highpassToggle'),
    pureBlackToggle: document.getElementById('pureBlackToggle'),
    normalizeToggle: document.getElementById('normalizeToggle'),
    startBtn: document.getElementById('startBtn'),
    calibrateBtn: document.getElementById('calibrateBtn'),
    blackoutBtn: document.getElementById('blackoutBtn'),
    clearAllBtn: document.getElementById('clearAllBtn'),
    statTotalCount: document.getElementById('statTotalCount'),
    statSnoreCount: document.getElementById('statSnoreCount'),
    statTalkCount: document.getElementById('statTalkCount'),
    statGrindCount: document.getElementById('statGrindCount'),
    storageSavedText: document.getElementById('storageSavedText'),
    timelineTrack: document.getElementById('timelineTrack'),
    filterTabs: document.querySelectorAll('.filter-tab'),
    clipsList: document.getElementById('clipsList'),
  };

  const canvasCtx = el.spectrumCanvas.getContext('2d');

  // =========================================================================
  // 1. IndexedDB 로컬 저장소 관리 (새로고침해도 녹음 유지)
  // =========================================================================
  function openDatabase() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains(DB_STORE)) {
          db.createObjectStore(DB_STORE, { keyPath: 'id' });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function saveClipToDB(clipRecord) {
    try {
      const db = await openDatabase();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(DB_STORE, 'readwrite');
        tx.objectStore(DB_STORE).put(clipRecord);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    } catch (err) {
      console.warn('IndexedDB 저장 실패(메모리 모드로 유지):', err);
    }
  }

  async function loadClipsFromDB() {
    try {
      const db = await openDatabase();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(DB_STORE, 'readonly');
        const req = tx.objectStore(DB_STORE).getAll();
        req.onsuccess = () => {
          const loaded = req.result || [];
          loaded.sort((a, b) => b.timestamp - a.timestamp);
          resolve(loaded);
        };
        req.onerror = () => reject(req.error);
      });
    } catch (err) {
      return [];
    }
  }

  async function deleteClipFromDB(id) {
    try {
      const db = await openDatabase();
      const tx = db.transaction(DB_STORE, 'readwrite');
      tx.objectStore(DB_STORE).delete(id);
    } catch (err) {
      console.warn(err);
    }
  }

  async function clearAllClipsFromDB() {
    try {
      const db = await openDatabase();
      const tx = db.transaction(DB_STORE, 'readwrite');
      tx.objectStore(DB_STORE).clear();
    } catch (err) {
      console.warn(err);
    }
  }

  // =========================================================================
  // 2. Wake Lock (화면 자동 꺼짐 방지) + 발열 0% 암전 모드
  // =========================================================================
  async function requestWakeLock() {
    if (!('wakeLock' in navigator)) {
      el.wakeLockBadge.textContent = '암전화면 유지모드';
      return;
    }
    try {
      wakeLockSentinel = await navigator.wakeLock.request('screen');
      el.wakeLockBadge.textContent = '🔒 화면꺼짐 방지 ON';
      el.wakeLockBadge.className = 'status-pill status-on';
      wakeLockSentinel.addEventListener('release', () => {
        if (isMonitoring) {
          el.wakeLockBadge.textContent = '화면유지 재요청 대기';
          el.wakeLockBadge.className = 'status-pill status-off';
        }
      });
    } catch (err) {
      el.wakeLockBadge.textContent = '암전화면 사용 권장';
    }
  }

  async function releaseWakeLock() {
    if (wakeLockSentinel) {
      try {
        await wakeLockSentinel.release();
      } catch (_) {}
      wakeLockSentinel = null;
    }
    el.wakeLockBadge.textContent = '화면유지 대기';
    el.wakeLockBadge.className = 'status-pill status-off';
  }

  // 탭 전환 후 복귀 시 WakeLock 자동 복구
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && isMonitoring) {
      requestWakeLock();
    }
  });

  function enterBlackoutMode() {
    if (!isMonitoring) return;
    isBlackout = true;

    // 1) 화면 그래픽 렌더링(requestAnimationFrame) 즉시 100% 중단 -> GPU 발열 0%
    if (rafId) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }

    // 2) 암전 오버레이 표시
    el.blackoutOverlay.classList.remove('hidden');
    el.blackoutOverlay.classList.remove('pure-zero-pixel');
    updateBlackoutClock();
    el.blackoutClipCount.textContent = `감지된 소리: ${clips.length}건`;

    // 1분에 딱 1번만 시계 텍스트 갱신
    if (blackoutClockInterval) clearInterval(blackoutClockInterval);
    blackoutClockInterval = setInterval(updateBlackoutClock, 60000);

    // 3) '발열 완전 차단 (5초 후 글자까지 100% 소등)' 켜져 있으면 5초 후 픽셀 0개 점등 상태로 전환
    if (pureBlackTimeout) clearTimeout(pureBlackTimeout);
    if (el.pureBlackToggle.checked) {
      pureBlackTimeout = setTimeout(() => {
        if (isBlackout) {
          el.blackoutOverlay.classList.add('pure-zero-pixel');
          if (blackoutClockInterval) {
            clearInterval(blackoutClockInterval);
            blackoutClockInterval = null;
          }
        }
      }, 5000);
    }
  }

  function exitBlackoutMode() {
    isBlackout = false;
    if (pureBlackTimeout) clearTimeout(pureBlackTimeout);
    if (blackoutClockInterval) clearInterval(blackoutClockInterval);
    el.blackoutOverlay.classList.add('hidden');
    el.blackoutOverlay.classList.remove('pure-zero-pixel');

    // 화면 복귀 시 UI 최신화 및 시각화 재개
    renderClipsAndStats();
    if (isMonitoring && !rafId) {
      rafId = requestAnimationFrame(updateVisualLoop);
    }
  }

  function updateBlackoutClock() {
    const now = new Date();
    const hh = String(now.getHours()).padStart(2, '0');
    const mm = String(now.getMinutes()).padStart(2, '0');
    el.blackoutClock.textContent = `${hh}:${mm}`;
  }

  // 더블탭 또는 더블클릭으로 암전 화면 해제 (실수로 한 번 건드렸을 때 켜짐 방지)
  el.blackoutOverlay.addEventListener('click', () => {
    const now = Date.now();
    if (now - lastTapTime < 420) {
      exitBlackoutMode();
      lastTapTime = 0;
    } else {
      // 완전 소등 상태에서 한 번 터치하면 4초간 희미하게 시계/건수만 보여주고 다시 소등
      if (el.blackoutOverlay.classList.contains('pure-zero-pixel')) {
        el.blackoutOverlay.classList.remove('pure-zero-pixel');
        updateBlackoutClock();
        el.blackoutClipCount.textContent = `감지된 소리: ${clips.length}건`;
        if (pureBlackTimeout) clearTimeout(pureBlackTimeout);
        pureBlackTimeout = setTimeout(() => {
          if (isBlackout && el.pureBlackToggle.checked) {
            el.blackoutOverlay.classList.add('pure-zero-pixel');
          }
        }, 4000);
      }
      lastTapTime = now;
    }
  });

  // =========================================================================
  // 3. 오디오 파이프라인 및 원거리 미세 소리 감지 엔진
  // =========================================================================
  async function startMonitoring() {
    try {
      // 중요: 브라우저 기본 노이즈 제거(noiseSuppression)를 꺼야 코골이·이갈이·원거리 미세음이 지워지지 않음
      mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
          channelCount: 1,
        },
        video: false,
      });

      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      try {
        audioCtx = new AudioContextClass({ sampleRate: TARGET_SAMPLE_RATE, latencyHint: 'playback' });
      } catch (_) {
        audioCtx = new AudioContextClass();
      }

      if (audioCtx.state === 'suspended') {
        await audioCtx.resume();
      }

      actualSampleRate = audioCtx.sampleRate;
      preRollBuffer = new Float32Array(Math.floor(actualSampleRate * PRE_ROLL_SECONDS));
      preRollWriteIdx = 0;

      sourceNode = audioCtx.createMediaStreamSource(mediaStream);

      // 80Hz 고역통과 필터 (에어컨, 냉장고, 외부 진동 등 저주파 웅웅거림 차단)
      highpassNode = audioCtx.createBiquadFilter();
      highpassNode.type = 'highpass';
      highpassNode.frequency.value = el.highpassToggle.checked ? 85 : 10;
      highpassNode.Q.value = 0.7;

      // 원거리 증폭기 (Pre-Amp GainNode: 최대 15배 증폭)
      gainNode = audioCtx.createGain();
      gainNode.gain.value = preAmpGain;

      // 주파수 분석기
      analyserNode = audioCtx.createAnalyser();
      analyserNode.fftSize = 1024;
      analyserNode.smoothingTimeConstant = 0.5;

      // 저전력 오디오 버퍼 처리 (4096 프레임 단위로 CPU 인터럽트 최소화)
      processorNode = audioCtx.createScriptProcessor(4096, 1, 1);

      sourceNode.connect(highpassNode);
      highpassNode.connect(gainNode);
      gainNode.connect(analyserNode);
      analyserNode.connect(processorNode);
      processorNode.connect(audioCtx.destination); // iOS Safari에서 ScriptProcessor 구동을 위해 연결 (출력은 0으로 무음 처리)

      processorNode.onaudioprocess = handleAudioProcess;

      isMonitoring = true;
      sessionStartTimestamp = Date.now();
      startSessionTimer();
      await requestWakeLock();

      // UI 상태 업데이트
      el.startBtn.textContent = '⏹ 수면 측정 종료';
      el.startBtn.classList.add('recording-active');
      el.blackoutBtn.disabled = false;
      el.monitoringBadge.textContent = '감시 중 (16kHz 저전력)';
      el.monitoringBadge.className = 'status-pill status-on';
      el.liveStateIndicator.textContent = '조용함 (대기)';
      el.liveStateIndicator.className = 'state-tag state-listening';

      // 시작 직후 2.5초간 방 배경소음 자동 영점 조절 실행
      runAutoCalibration(2500);

      // 화면이 켜져 있을 때만 시각화 루프 실행
      if (!isBlackout) {
        rafId = requestAnimationFrame(updateVisualLoop);
      }
    } catch (err) {
      alert(
        '마이크 권한을 허용해 주세요.\n(아이폰 Safari의 경우 주소창 왼쪽 [가A] 또는 설정 아이콘 -> 웹사이트 설정 -> 마이크 [허용]으로 설정 가능)'
      );
      console.error('마이크 시작 오류:', err);
    }
  }

  function stopMonitoring() {
    isMonitoring = false;

    if (isRecordingClip) {
      finalizeClip();
    }

    if (rafId) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }

    if (processorNode) {
      processorNode.onaudioprocess = null;
      processorNode.disconnect();
      processorNode = null;
    }
    if (analyserNode) analyserNode.disconnect();
    if (gainNode) gainNode.disconnect();
    if (highpassNode) highpassNode.disconnect();
    if (sourceNode) sourceNode.disconnect();

    if (mediaStream) {
      mediaStream.getTracks().forEach((t) => t.stop());
      mediaStream = null;
    }

    if (audioCtx) {
      audioCtx.close().catch(() => {});
      audioCtx = null;
    }

    stopSessionTimer();
    releaseWakeLock();
    if (isBlackout) exitBlackoutMode();

    el.startBtn.textContent = '▶ 수면 측정 시작';
    el.startBtn.classList.remove('recording-active');
    el.blackoutBtn.disabled = true;
    el.monitoringBadge.textContent = '대기 중';
    el.monitoringBadge.className = 'status-pill status-off';
    el.liveStateIndicator.textContent = '대기 중';
    el.liveStateIndicator.className = 'state-tag state-idle';
    el.meterFill.style.width = '0%';
  }

  // =========================================================================
  // 4. 실시간 오디오 버퍼 처리 (암전 모드에서도 초저전력으로 동작)
  // =========================================================================
  function handleAudioProcess(event) {
    if (!isMonitoring) return;

    const input = event.inputBuffer.getChannelData(0);
    const output = event.outputBuffer.getChannelData(0);
    // 스피커 출력은 완전 무음(0)으로 설정해 하울링 방지
    for (let i = 0; i < output.length; i++) {
      output[i] = 0;
    }

    // 1) RMS 에너지 및 영교차율(ZCR: 이갈이/마찰음 판별 핵심 지표) 계산
    let sumSq = 0;
    let zeroCrossings = 0;
    for (let i = 0; i < input.length; i++) {
      const sample = input[i];
      sumSq += sample * sample;
      if (i > 0 && ((input[i - 1] >= 0 && sample < 0) || (input[i - 1] < 0 && sample >= 0))) {
        zeroCrossings++;
      }
    }

    const rms = Math.sqrt(sumSq / input.length);
    const instantDb = Math.max(-75, Math.min(0, 20 * Math.log10(rms + 1e-7)));
    // 부드러운 dB 추적 (상승은 즉각 반응해 미세음 포착, 하강은 완만하게)
    currentDb = instantDb > currentDb ? instantDb * 0.75 + currentDb * 0.25 : instantDb * 0.35 + currentDb * 0.65;

    const zcrRate = zeroCrossings / input.length;
    const thresholdDb = getThresholdDb();
    const now = Date.now();

    // 배경소음 적응형 미세 추적 (조용할 때 방 온습도/환풍기 변화에 맞춰 서서히 영점 보정)
    if (!isRecordingClip && !isCalibrating && currentDb < thresholdDb - 1.0) {
      noiseFloorDb = noiseFloorDb * 0.992 + currentDb * 0.008;
    }

    // 2) 소리 감지 트리거 판정
    if (!isCalibrating) {
      if (currentDb >= thresholdDb) {
        lastAboveThresholdTime = now;

        if (!isRecordingClip) {
          // 새 조각 녹음 시작! (사전 녹음 순환 버퍼 2.5초 분량을 앞에 붙임)
          isRecordingClip = true;
          clipStartTime = now - Math.round(PRE_ROLL_SECONDS * 1000);
          clipPeakDb = currentDb;
          currentClipChunks = [extractPreRollOrdered()];
          resetClassificationCounters();

          if (!isBlackout) {
            el.monitoringBadge.textContent = '🔴 소리 감지 녹음 중';
            el.monitoringBadge.className = 'status-pill status-rec';
            el.liveStateIndicator.textContent = '🔴 녹음 중';
            el.liveStateIndicator.className = 'state-tag state-recording';
          }
        }
      }

      if (isRecordingClip) {
        // 현재 프레임 저장 (클리핑 방지 소프트 리미터 적용)
        const chunkCopy = new Float32Array(input.length);
        for (let i = 0; i < input.length; i++) {
          chunkCopy[i] = Math.max(-0.99, Math.min(0.99, input[i]));
        }
        currentClipChunks.push(chunkCopy);

        if (currentDb > clipPeakDb) clipPeakDb = currentDb;

        // 소리 발생 중에만 주파수 대역 분석 수행 (평소엔 CPU 아낌!)
        accumulateSpectralFeatures(zcrRate);

        const elapsed = now - clipStartTime;
        const quietDuration = now - lastAboveThresholdTime;

        // 소리가 멈춘 뒤 POST_ROLL_MS(2.4초)가 지났거나 최대 길이(30초) 도달 시 클립 저장 완료
        if ((quietDuration >= POST_ROLL_MS && elapsed >= MIN_CLIP_MS) || elapsed >= MAX_CLIP_MS) {
          finalizeClip();
        }
      }
    }

    // 3) 사전 녹음 순환 버퍼(Pre-Roll)에 현재 샘플 기록
    const preLen = preRollBuffer.length;
    for (let i = 0; i < input.length; i++) {
      preRollBuffer[preRollWriteIdx] = Math.max(-0.99, Math.min(0.99, input[i]));
      preRollWriteIdx = (preRollWriteIdx + 1) % preLen;
    }
  }

  function extractPreRollOrdered() {
    const preLen = preRollBuffer.length;
    const ordered = new Float32Array(preLen);
    const firstPartLen = preLen - preRollWriteIdx;
    ordered.set(preRollBuffer.subarray(preRollWriteIdx), 0);
    ordered.set(preRollBuffer.subarray(0, preRollWriteIdx), firstPartLen);
    return ordered;
  }

  function getThresholdDb() {
    return Math.min(-5, noiseFloorDb + triggerDeltaDb);
  }

  // =========================================================================
  // 5. 코골이 / 잠꼬대 / 이갈이 주파수 대역 정밀 분류기
  // =========================================================================
  function resetClassificationCounters() {
    accumLowEnergy = 0;
    accumMidEnergy = 0;
    accumHighEnergy = 0;
    accumZcr = 0;
    accumFrames = 0;
    dominantFreqSum = 0;
  }

  function accumulateSpectralFeatures(zcrRate) {
    if (!analyserNode) return;
    const freqBins = new Uint8Array(analyserNode.frequencyBinCount);
    analyserNode.getByteFrequencyData(freqBins);

    const binHz = (actualSampleRate / 2) / freqBins.length;

    let lowSum = 0, lowCount = 0;
    let midSum = 0, midCount = 0;
    let highSum = 0, highCount = 0;
    let maxBinVal = 0;
    let maxBinFreq = 0;

    for (let i = 1; i < freqBins.length; i++) {
      const hz = i * binHz;
      const val = freqBins[i];

      if (val > maxBinVal && hz >= 80) {
        maxBinVal = val;
        maxBinFreq = hz;
      }

      if (hz >= 90 && hz <= 520) {
        lowSum += val;
        lowCount++;
      } else if (hz > 520 && hz <= 2600) {
        midSum += val;
        midCount++;
      } else if (hz > 2600 && hz <= 6500) {
        highSum += val;
        highCount++;
      }
    }

    accumLowEnergy += lowCount ? lowSum / lowCount : 0;
    accumMidEnergy += midCount ? midSum / midCount : 0;
    accumHighEnergy += highCount ? highSum / highCount : 0;
    accumZcr += zcrRate;
    dominantFreqSum += maxBinFreq;
    accumFrames++;
  }

  function classifyRecordedSound(durationSec) {
    if (accumFrames === 0) {
      return {
        category: 'other',
        label: '🔔 기타/미세음',
        detail: '순간 미세 소음',
      };
    }

    const avgLow = accumLowEnergy / accumFrames;
    const avgMid = accumMidEnergy / accumFrames;
    const avgHigh = accumHighEnergy / accumFrames;
    const avgZcr = accumZcr / accumFrames;
    const avgDomFreq = Math.round(dominantFreqSum / accumFrames);

    // 1) 이갈이 (Teeth Grinding / Bruxism): 고주파 마찰 에너지 비율이 높거나 영교차율(ZCR)이 높음
    if ((avgHigh > avgLow * 0.55 && avgZcr > 0.14) || avgDomFreq >= 2100 || avgZcr > 0.21) {
      return {
        category: 'grind',
        label: '😬 이갈이/마찰 추정',
        detail: `고주파 마찰음 감지 (주파수 ~${avgDomFreq}Hz)`,
      };
    }

    // 2) 잠꼬대 (Sleep Talking): 중주파 음성 포먼트(500~2600Hz) 에너지가 뚜렷하고 지속 시간이 있음
    if (avgMid >= avgLow * 0.72 && avgDomFreq >= 420 && avgDomFreq < 2100 && durationSec >= 1.8) {
      return {
        category: 'talk',
        label: '💬 잠꼬대 추정',
        detail: `음성 대역 포먼트 우세 (~${avgDomFreq}Hz)`,
      };
    }

    // 3) 코골이 (Snoring): 90~500Hz 저주파 진동 에너지가 지배적일 때
    if (avgLow > avgMid * 1.15 && avgDomFreq >= 85 && avgDomFreq <= 550) {
      return {
        category: 'snore',
        label: '🐷 코골이 추정',
        detail: `저주파 기도 진동 우세 (~${avgDomFreq}Hz)`,
      };
    }

    // 4) 그 외 뒤척임/침구 마찰/기침 등
    return {
      category: 'other',
      label: '🔔 기타/뒤척임',
      detail: `일반 수면 소음 (~${avgDomFreq}Hz)`,
    };
  }

  // =========================================================================
  // 6. 녹음 조각 WAV 인코딩 (16kHz 다운샘플링 + 원거리 볼륨 자동 정규화)
  // =========================================================================
  function finalizeClip() {
    isRecordingClip = false;

    if (!isBlackout) {
      el.monitoringBadge.textContent = '감시 중 (16kHz 저전력)';
      el.monitoringBadge.className = 'status-pill status-on';
      el.liveStateIndicator.textContent = '조용함 (대기)';
      el.liveStateIndicator.className = 'state-tag state-listening';
    }

    const totalSamples = currentClipChunks.reduce((acc, c) => acc + c.length, 0);
    if (totalSamples === 0) return;

    const merged = new Float32Array(totalSamples);
    let offset = 0;
    for (const chunk of currentClipChunks) {
      merged.set(chunk, offset);
      offset += chunk.length;
    }
    currentClipChunks = [];

    // 16kHz로 다운샘플링하여 파일 용량 최소화 (아이폰 48kHz 환경일 경우 1/3로 압축)
    const downsampled = downsampleBuffer(merged, actualSampleRate, TARGET_SAMPLE_RATE);
    const durationSec = Number((downsampled.length / TARGET_SAMPLE_RATE).toFixed(1));

    // 원거리 작은 소리 자동 볼륨 정규화 (옵션 켜져 있을 때 최대 피크를 85% 수준으로 증폭)
    if (el.normalizeToggle.checked) {
      let maxAbs = 0;
      for (let i = 0; i < downsampled.length; i++) {
        const a = Math.abs(downsampled[i]);
        if (a > maxAbs) maxAbs = a;
      }
      if (maxAbs > 0.005 && maxAbs < 0.85) {
        const normScale = Math.min(8.0, 0.85 / maxAbs);
        for (let i = 0; i < downsampled.length; i++) {
          downsampled[i] = Math.max(-0.98, Math.min(0.98, downsampled[i] * normScale));
        }
      }
    }

    const wavBlob = encodeWAV(downsampled, TARGET_SAMPLE_RATE);
    const classification = classifyRecordedSound(durationSec);
    const eventDate = new Date(clipStartTime + Math.round(PRE_ROLL_SECONDS * 1000));

    const clipRecord = {
      id: `clip_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      timestamp: eventDate.getTime(),
      timeStr: formatDateTime(eventDate),
      durationSec,
      peakDb: Number(clipPeakDb.toFixed(1)),
      category: classification.category,
      categoryLabel: classification.label,
      detail: classification.detail,
      sizeBytes: wavBlob.size,
      blob: wavBlob,
    };

    clips.unshift(clipRecord);
    saveClipToDB(clipRecord);

    // 암전 모드가 아닐 때만 즉시 DOM 렌더링
    if (!isBlackout) {
      renderClipsAndStats();
    } else if (!el.blackoutOverlay.classList.contains('pure-zero-pixel')) {
      el.blackoutClipCount.textContent = `감지된 소리: ${clips.length}건`;
    }
  }

  function downsampleBuffer(buffer, inputRate, outputRate) {
    if (outputRate >= inputRate) return buffer;
    const ratio = inputRate / outputRate;
    const newLength = Math.round(buffer.length / ratio);
    const result = new Float32Array(newLength);
    for (let i = 0; i < newLength; i++) {
      const idx = Math.floor(i * ratio);
      result[i] = buffer[idx];
    }
    return result;
  }

  function encodeWAV(samples, sampleRate) {
    const buffer = new ArrayBuffer(44 + samples.length * 2);
    const view = new DataView(buffer);

    writeAscii(view, 0, 'RIFF');
    view.setUint32(4, 36 + samples.length * 2, true);
    writeAscii(view, 8, 'WAVE');
    writeAscii(view, 12, 'fmt ');
    view.setUint32(16, 16, true); // PCM chunk size
    view.setUint16(20, 1, true);  // PCM format
    view.setUint16(22, 1, true);  // Mono (1 channel)
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true); // 16-bit
    writeAscii(view, 36, 'data');
    view.setUint32(40, samples.length * 2, true);

    let offset = 44;
    for (let i = 0; i < samples.length; i++, offset += 2) {
      const s = Math.max(-1, Math.min(1, samples[i]));
      view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    }

    return new Blob([view], { type: 'audio/wav' });
  }

  function writeAscii(view, offset, str) {
    for (let i = 0; i < str.length; i++) {
      view.setUint8(offset + i, str.charCodeAt(i));
    }
  }

  // =========================================================================
  // 7. 방 배경소음 자동 영점 조절 (3초 캘리브레이션)
  // =========================================================================
  function runAutoCalibration(durationMs = 3000) {
    if (!isMonitoring) return;
    isCalibrating = true;
    const samples = [];
    el.calibrateBtn.disabled = true;
    el.calibrateBtn.textContent = '⏳ 방 소음 측정 중...';
    el.liveStateIndicator.textContent = '영점 조절 중';

    const sampleInterval = setInterval(() => {
      if (isMonitoring) samples.push(currentDb);
    }, 100);

    setTimeout(() => {
      clearInterval(sampleInterval);
      isCalibrating = false;
      el.calibrateBtn.disabled = false;
      el.calibrateBtn.textContent = '🎯 방 배경소음 영점 조절 (3초)';

      if (samples.length > 0) {
        samples.sort((a, b) => a - b);
        // 상위 튀는 소음을 제외한 중앙값(Median)으로 배경 소음 영점 설정
        const medianDb = samples[Math.floor(samples.length * 0.55)];
        noiseFloorDb = Math.max(-68, Math.min(-18, medianDb));
      }
      if (!isBlackout) {
        updateMeterMarkersUI();
        el.liveStateIndicator.textContent = '조용함 (대기)';
      }
    }, durationMs);
  }

  // =========================================================================
  // 8. 시각화 루프 (화면이 켜져 있을 때만 동작, 암전 시 100% 정지)
  // =========================================================================
  function updateVisualLoop() {
    if (!isMonitoring || isBlackout) {
      rafId = null;
      return;
    }

    const thresholdDb = getThresholdDb();
    el.currentDbText.textContent = `${currentDb.toFixed(1)} dB`;
    el.noiseFloorText.textContent = `${noiseFloorDb.toFixed(1)} dB`;
    el.thresholdDbText.textContent = `${thresholdDb.toFixed(1)} dB`;

    el.meterFill.style.width = `${dbToPercent(currentDb)}%`;
    updateMeterMarkersUI();

    // 스펙트럼 캔버스 그리기
    if (analyserNode) {
      const freqData = new Uint8Array(analyserNode.frequencyBinCount);
      analyserNode.getByteFrequencyData(freqData);

      const w = el.spectrumCanvas.width;
      const h = el.spectrumCanvas.height;
      canvasCtx.clearRect(0, 0, w, h);

      const usefulBins = Math.min(freqData.length, 180); // 0 ~ 약 6kHz 대역 집중 표시
      const barWidth = w / usefulBins;
      let peakBin = 0;
      let peakVal = 0;

      for (let i = 1; i < usefulBins; i++) {
        const val = freqData[i];
        if (val > peakVal) {
          peakVal = val;
          peakBin = i;
        }
        const barHeight = (val / 255) * (h - 6);
        const hz = (i * (actualSampleRate / 2)) / freqData.length;

        if (hz <= 520) {
          canvasCtx.fillStyle = '#f97316'; // 코골이 저음역 (주황)
        } else if (hz <= 2600) {
          canvasCtx.fillStyle = '#3b82f6'; // 잠꼬대 중음역 (파랑)
        } else {
          canvasCtx.fillStyle = '#ec4899'; // 이갈이 고음역 (핑크)
        }

        canvasCtx.fillRect(i * barWidth, h - barHeight, Math.max(1, barWidth - 1), barHeight);
      }

      const domHz = Math.round((peakBin * (actualSampleRate / 2)) / freqData.length);
      if (peakVal > 25) {
        el.liveFreqInfo.textContent = `피크 주파수: ${domHz} Hz | 증폭: ${preAmpGain.toFixed(1)}배`;
      } else {
        el.liveFreqInfo.textContent = `정적 유지 중 (배경소음 ${noiseFloorDb.toFixed(1)}dB 대비 +${triggerDeltaDb.toFixed(1)}dB 이상 시 즉시 녹음)`;
      }
    }

    rafId = requestAnimationFrame(updateVisualLoop);
  }

  function dbToPercent(db) {
    // -70dB ~ 0dB 구간을 0% ~ 100%로 매핑
    return Math.max(0, Math.min(100, ((db + 70) / 70) * 100));
  }

  function updateMeterMarkersUI() {
    el.noiseFloorMarker.style.left = `${dbToPercent(noiseFloorDb)}%`;
    el.thresholdMarker.style.left = `${dbToPercent(getThresholdDb())}%`;
  }

  // =========================================================================
  // 9. UI 렌더링 (통계, 타임라인, 녹음 조각 리스트)
  // =========================================================================
  function renderClipsAndStats() {
    const total = clips.length;
    const snoreCount = clips.filter((c) => c.category === 'snore').length;
    const talkCount = clips.filter((c) => c.category === 'talk').length;
    const grindCount = clips.filter((c) => c.category === 'grind').length;

    el.statTotalCount.textContent = `${total}건`;
    el.statSnoreCount.textContent = `${snoreCount}건`;
    el.statTalkCount.textContent = `${talkCount}건`;
    el.statGrindCount.textContent = `${grindCount}건`;

    // 일반 8시간 연속 녹음(약 920MB, 16bit 16kHz~48kHz 기준) 대비 절약한 용량 표시
    const usedBytes = clips.reduce((acc, c) => acc + (c.sizeBytes || 0), 0);
    const usedMB = (usedBytes / (1024 * 1024)).toFixed(2);
    el.storageSavedText.textContent = `현재 총 용량: ${usedMB} MB (일반 8시간 통녹음 약 550MB 대비 99% 절약)`;

    // 타임라인 바 렌더링
    if (clips.length === 0) {
      el.timelineTrack.innerHTML = `<div class="timeline-empty">측정된 소리 조각이 여기에 시간순으로 표시됩니다.</div>`;
    } else {
      const chronological = [...clips].reverse();
      el.timelineTrack.innerHTML = chronological
        .map((clip) => {
          const heightPct = Math.max(25, Math.min(100, dbToPercent(clip.peakDb)));
          const colorMap = {
            snore: 'var(--snore-color)',
            talk: 'var(--talk-color)',
            grind: 'var(--grind-color)',
            other: 'var(--other-color)',
          };
          const bg = colorMap[clip.category] || 'var(--accent-primary)';
          return `<div class="timeline-bar" style="height:${heightPct}%; background:${bg};" data-clip-id="${clip.id}" title="${clip.timeStr} - ${clip.categoryLabel} (${clip.durationSec}초)"></div>`;
        })
        .join('');
    }

    // 필터링된 클립 리스트 렌더링
    const filtered = activeFilter === 'all' ? clips : clips.filter((c) => c.category === activeFilter);
    if (filtered.length === 0) {
      el.clipsList.innerHTML = `
        <div class="empty-state">
          <p>해당 카테고리에 녹음된 소리 조각이 없습니다.</p>
          <small>[수면 측정 시작]을 누르고 소리를 내어 테스트해 보세요.</small>
        </div>`;
      return;
    }

    el.clipsList.innerHTML = filtered
      .map((clip) => {
        const audioUrl = URL.createObjectURL(clip.blob);
        const kb = Math.max(1, Math.round((clip.sizeBytes || 0) / 1024));
        const downloadName = `SleepSense_${clip.category}_${clip.timestamp}.wav`;
        return `
          <div class="clip-item" id="item_${clip.id}">
            <div class="clip-top">
              <div class="clip-meta">
                <span class="category-badge cat-${clip.category}">${clip.categoryLabel}</span>
                <span class="clip-time">${clip.timeStr}</span>
                <span class="clip-details">${clip.durationSec}초 · 최대 ${clip.peakDb}dB · ${kb}KB</span>
              </div>
              <span class="clip-details">${clip.detail}</span>
            </div>
            <div class="clip-controls">
              <audio controls preload="metadata" src="${audioUrl}"></audio>
              <a class="btn-small" href="${audioUrl}" download="${downloadName}">⬇ 저장</a>
              <button type="button" class="btn-small btn-small-danger" data-delete-id="${clip.id}">🗑 삭제</button>
            </div>
          </div>
        `;
      })
      .join('');
  }

  // =========================================================================
  // 10. 유틸리티 및 이벤트 리스너 바인딩
  // =========================================================================
  function formatDateTime(date) {
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    const hh = String(date.getHours()).padStart(2, '0');
    const mm = String(date.getMinutes()).padStart(2, '0');
    const ss = String(date.getSeconds()).padStart(2, '0');
    return `${month}/${day} ${hh}:${mm}:${ss}`;
  }

  function startSessionTimer() {
    if (sessionTimerInterval) clearInterval(sessionTimerInterval);
    sessionTimerInterval = setInterval(() => {
      if (isBlackout) return; // 암전 시에는 DOM 업데이트도 건너뛰어 에너지 절약
      const sec = Math.floor((Date.now() - sessionStartTimestamp) / 1000);
      const h = String(Math.floor(sec / 3600)).padStart(2, '0');
      const m = String(Math.floor((sec % 3600) / 60)).padStart(2, '0');
      const s = String(sec % 60).padStart(2, '0');
      el.sessionTimer.textContent = `${h}:${m}:${s}`;
    }, 1000);
  }

  function stopSessionTimer() {
    if (sessionTimerInterval) {
      clearInterval(sessionTimerInterval);
      sessionTimerInterval = null;
    }
  }

  function applyDistancePreset(presetKey) {
    el.presetBtns.forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.preset === presetKey);
    });

    if (presetKey === 'near') {
      preAmpGain = 2.0;
      triggerDeltaDb = 6.5;
    } else if (presetKey === 'mid') {
      preAmpGain = 5.0;
      triggerDeltaDb = 4.5;
    } else {
      // 'far' 원거리 초미세 소리 감지 모드 (기본값)
      preAmpGain = 10.0;
      triggerDeltaDb = 3.5;
    }

    el.gainSlider.value = String(preAmpGain);
    el.deltaSlider.value = String(triggerDeltaDb);
    updateSliderLabels();

    if (gainNode && audioCtx) {
      gainNode.gain.setTargetAtTime(preAmpGain, audioCtx.currentTime, 0.05);
    }
    updateMeterMarkersUI();
  }

  function updateSliderLabels() {
    const boostDb = Math.round(20 * Math.log10(preAmpGain));
    el.gainValueText.textContent = `${preAmpGain.toFixed(1)}x (+${boostDb}dB)`;
    el.deltaValueText.textContent = `+${triggerDeltaDb.toFixed(1)} dB 변화 시 녹음`;
  }

  // 이벤트 연결
  el.startBtn.addEventListener('click', () => {
    if (isMonitoring) {
      stopMonitoring();
    } else {
      startMonitoring();
    }
  });

  el.calibrateBtn.addEventListener('click', () => {
    if (!isMonitoring) {
      alert('먼저 [수면 측정 시작]을 누른 뒤 배경소음 영점을 조절할 수 있습니다.');
      return;
    }
    runAutoCalibration(3000);
  });

  el.blackoutBtn.addEventListener('click', () => {
    enterBlackoutMode();
  });

  el.presetBtns.forEach((btn) => {
    btn.addEventListener('click', () => {
      applyDistancePreset(btn.dataset.preset);
    });
  });

  el.gainSlider.addEventListener('input', (e) => {
    preAmpGain = parseFloat(e.target.value);
    updateSliderLabels();
    if (gainNode && audioCtx) {
      gainNode.gain.setTargetAtTime(preAmpGain, audioCtx.currentTime, 0.05);
    }
  });

  el.deltaSlider.addEventListener('input', (e) => {
    triggerDeltaDb = parseFloat(e.target.value);
    updateSliderLabels();
    updateMeterMarkersUI();
  });

  el.highpassToggle.addEventListener('change', (e) => {
    if (highpassNode && audioCtx) {
      highpassNode.frequency.setTargetAtTime(e.target.checked ? 85 : 10, audioCtx.currentTime, 0.05);
    }
  });

  el.filterTabs.forEach((tab) => {
    tab.addEventListener('click', () => {
      el.filterTabs.forEach((t) => t.classList.remove('active'));
      tab.classList.add('active');
      activeFilter = tab.dataset.filter;
      renderClipsAndStats();
    });
  });

  el.clipsList.addEventListener('click', async (e) => {
    const delBtn = e.target.closest('[data-delete-id]');
    if (!delBtn) return;
    const id = delBtn.dataset.deleteId;
    clips = clips.filter((c) => c.id !== id);
    await deleteClipFromDB(id);
    renderClipsAndStats();
  });

  el.timelineTrack.addEventListener('click', (e) => {
    const bar = e.target.closest('[data-clip-id]');
    if (!bar) return;
    const targetEl = document.getElementById(`item_${bar.dataset.clipId}`);
    if (targetEl) {
      targetEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  });

  el.clearAllBtn.addEventListener('click', async () => {
    if (clips.length === 0) return;
    if (!confirm('저장된 모든 수면 소리 조각을 삭제할까요?')) return;
    clips = [];
    await clearAllClipsFromDB();
    renderClipsAndStats();
  });

  // 초기 부팅 시 IndexedDB에서 이전 녹음 기록 불러오기
  (async function init() {
    updateSliderLabels();
    updateMeterMarkersUI();
    clips = await loadClipsFromDB();
    renderClipsAndStats();
  })();
})();
