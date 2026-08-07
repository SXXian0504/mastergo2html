(() => {
  const deck = document.querySelector('.deck');
  const slides = [...document.querySelectorAll('.slide')];
  const progressCount = document.querySelector('.progress-count');
  const progressDots = document.querySelector('.progress-dots');
  const prevButton = document.querySelector('[data-action="prev"]');
  const nextButton = document.querySelector('[data-action="next"]');
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const requested = Number.parseInt(location.hash.slice(1), 10);
  let current = Number.isFinite(requested) ? Math.max(0, Math.min(requested - 1, slides.length - 1)) : 0;
  let locked = false;
  let workflowLocked = false;
  let accuracyLocked = false;
  let controlLocked = false;
  let futureLocked = false;
  let wheelLock = false;
  let touchStartX = 0;

  const workflowSlide = slides.find((slide) => slide.classList.contains('workflow-slide'));
  const demoSlide = slides.find((slide) => slide.classList.contains('demo-slide'));
  const accuracySlide = slides.find((slide) => slide.classList.contains('accuracy-slide'));
  const usabilitySlide = slides.find((slide) => slide.classList.contains('usability-slide'));
  const controlSlide = slides.find((slide) => slide.classList.contains('control-slide'));
  const futureSlide = slides.find((slide) => slide.classList.contains('future-slide'));
  const videoStage = demoSlide?.querySelector('.video-stage');
  const demoVideo = videoStage?.querySelector('.demo-video');
  const videoPlayButton = videoStage?.querySelector('.video-play-button');
  const videoProgress = videoStage?.querySelector('.video-progress');
  let videoControlsTimer = 0;
  let workflowStep = reduceMotion ? 4 : Number(workflowSlide?.dataset.workflowStep || 0);
  let accuracyStep = Number(accuracySlide?.dataset.accuracyStep || 0);
  let usabilityStep = 4;
  let controlStep = reduceMotion ? 4 : Number(controlSlide?.dataset.controlStep || 1);
  let futureStep = Number(futureSlide?.dataset.futureStep || 0);

  slides.forEach((slide, index) => {
    slide.setAttribute('aria-label', `第 ${index + 1} / ${slides.length} 页`);
    slide.setAttribute('aria-hidden', index === current ? 'false' : 'true');
    const pageIndicator = document.createElement('div');
    pageIndicator.className = 'page-indicator';
    pageIndicator.innerHTML = `<span>${slide.dataset.page}</span><i></i>`;
    slide.prepend(pageIndicator);
  });

  slides.forEach((_, index) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'progress-dot';
    button.dataset.index = String(index);
    button.setAttribute('aria-label', `跳到第 ${index + 1} 页`);
    progressDots.append(button);
  });

  function fitDeck() {
    const scale = Math.min(window.innerWidth / 1672, window.innerHeight / 941);
    document.documentElement.style.setProperty('--deck-scale', scale.toFixed(5));
  }

  function hasVideoSource() {
    return Boolean(
      demoVideo?.currentSrc ||
      demoVideo?.getAttribute('src') ||
      demoVideo?.querySelector('source[src]')?.getAttribute('src')
    );
  }

  function isVideoPlaying() {
    return Boolean(demoVideo && hasVideoSource() && !demoVideo.paused && !demoVideo.ended);
  }

  function setVideoState(state) {
    if (!videoStage) return;
    videoStage.dataset.videoState = state;
    if (videoPlayButton) {
      const playing = state === 'playing';
      videoPlayButton.setAttribute('aria-label', playing ? '暂停视频' : state === 'ended' ? '重播视频' : '播放视频');
      videoPlayButton.setAttribute('aria-disabled', hasVideoSource() ? 'false' : 'true');
    }
    updateControls();
  }

  function revealVideoControls() {
    if (!videoStage || !isVideoPlaying()) return;
    videoStage.classList.add('show-controls');
    window.clearTimeout(videoControlsTimer);
    videoControlsTimer = window.setTimeout(() => videoStage.classList.remove('show-controls'), 1800);
  }

  function toggleVideo() {
    if (!demoVideo || !hasVideoSource()) return false;
    if (demoVideo.paused || demoVideo.ended) {
      if (demoVideo.ended) demoVideo.currentTime = 0;
      // When the deck is opened directly from the filesystem, explicitly kick
      // the media element once before play() so browsers do not leave it in the
      // NETWORK_EMPTY state after a cached slide navigation.
      if (demoVideo.networkState === HTMLMediaElement.NETWORK_EMPTY) demoVideo.load();
      demoVideo.play().catch(() => setVideoState('ready'));
    } else {
      demoVideo.pause();
    }
    return true;
  }

  function exitVideoPlayback() {
    if (!demoVideo || !hasVideoSource()) return;
    demoVideo.pause();
    setVideoState('ready');
    videoStage?.classList.remove('show-controls');
  }

  function pauseVideoForNavigation() {
    if (!demoVideo || !hasVideoSource()) return;
    demoVideo.pause();
    videoStage?.classList.remove('show-controls');
  }

  function bindVideoControls() {
    if (!videoStage || !demoVideo) return;
    const markVideoReady = () => {
      if (videoProgress) videoProgress.value = '0';
      setVideoState('ready');
    };
    demoVideo.addEventListener('loadedmetadata', markVideoReady);
    demoVideo.addEventListener('loadeddata', markVideoReady);
    // The local MP4 can finish reading metadata before this script binds.
    // Synchronize the UI immediately instead of waiting for an event that may
    // already have fired.
    if (demoVideo.readyState >= HTMLMediaElement.HAVE_METADATA) markVideoReady();
    demoVideo.addEventListener('play', () => setVideoState('playing'));
    demoVideo.addEventListener('pause', () => {
      if (!demoVideo.ended) setVideoState(hasVideoSource() ? 'paused' : 'placeholder');
    });
    demoVideo.addEventListener('ended', () => {
      setVideoState('ended');
      videoStage.classList.remove('show-controls');
    });
    demoVideo.addEventListener('timeupdate', () => {
      if (videoProgress && Number.isFinite(demoVideo.duration) && demoVideo.duration > 0) {
        videoProgress.value = String(Math.round((demoVideo.currentTime / demoVideo.duration) * 1000));
      }
    });
    demoVideo.addEventListener('error', () => {
      videoStage.dataset.videoState = 'placeholder';
      videoStage.classList.remove('show-controls');
      if (videoPlayButton) {
        videoPlayButton.setAttribute('aria-disabled', 'false');
        videoPlayButton.setAttribute('aria-label', '视频加载失败，请重试');
      }
    });
    videoPlayButton?.addEventListener('click', toggleVideo);
    videoStage.querySelector('[data-video-action="toggle"]')?.addEventListener('click', toggleVideo);
    videoStage.querySelector('[data-video-action="mute"]')?.addEventListener('click', () => {
      demoVideo.muted = !demoVideo.muted;
    });
    videoStage.querySelector('[data-video-action="exit"]')?.addEventListener('click', exitVideoPlayback);
    videoProgress?.addEventListener('input', () => {
      if (Number.isFinite(demoVideo.duration) && demoVideo.duration > 0) {
        demoVideo.currentTime = (Number(videoProgress.value) / 1000) * demoVideo.duration;
      }
    });
    videoStage.addEventListener('mousemove', revealVideoControls);
    videoStage.addEventListener('mouseleave', () => {
      window.clearTimeout(videoControlsTimer);
      videoStage.classList.remove('show-controls');
    });
  }

  function syncWorkflow() {
    if (!workflowSlide) return;
    workflowSlide.dataset.workflowStep = String(workflowStep);
    workflowSlide.querySelectorAll('.workflow-node, .workflow-detail').forEach((item) => {
      const step = Number(item.dataset.step);
      item.classList.toggle('is-visible', step <= workflowStep);
      item.classList.toggle('is-active', step === workflowStep);
      item.classList.toggle('is-complete', step < workflowStep);
      item.setAttribute('aria-hidden', step <= workflowStep ? 'false' : 'true');
    });
    workflowSlide.querySelectorAll('.workflow-segment').forEach((segment) => {
      segment.classList.toggle('is-visible', Number(segment.dataset.step) <= workflowStep);
    });
  }

  function syncAccuracy() {
    if (!accuracySlide) return;
    accuracySlide.dataset.accuracyStep = String(accuracyStep);
    const showingLayout = accuracyStep === 0;
    const showingQaHeader = accuracyStep === 1;
    const showingDetail = accuracyStep >= 2;
    accuracySlide.querySelectorAll('.layout-shot').forEach((shot) => shot.setAttribute('aria-hidden', showingLayout ? 'false' : 'true'));
    accuracySlide.querySelectorAll('.qa-shot').forEach((shot) => shot.setAttribute('aria-hidden', showingQaHeader ? 'false' : 'true'));
    accuracySlide.querySelectorAll('.detail-shot').forEach((shot) => shot.setAttribute('aria-hidden', showingDetail ? 'false' : 'true'));
    accuracySlide.querySelector('.layout-summary')?.setAttribute('aria-hidden', showingLayout ? 'false' : 'true');
    accuracySlide.querySelector('.component-summary')?.setAttribute('aria-hidden', showingLayout ? 'true' : 'false');
  }

  function syncUsability() {
    if (!usabilitySlide) return;
    usabilitySlide.dataset.usabilityStep = String(usabilityStep);
    usabilitySlide.querySelectorAll('.usability-node').forEach((node) => {
      node.classList.add('is-visible');
      node.classList.remove('is-active', 'is-complete');
      node.setAttribute('aria-hidden', 'false');
    });
    usabilitySlide.querySelectorAll('.usability-connector').forEach((connector) => {
      connector.classList.add('is-visible');
    });
  }

  function syncControl() {
    if (!controlSlide) return;
    controlSlide.dataset.controlStep = String(controlStep);
    controlSlide.querySelectorAll('.control-stage').forEach((stage) => {
      const step = Number(stage.dataset.step);
      stage.classList.toggle('is-visible', step <= controlStep);
      stage.classList.toggle('is-active', step === controlStep);
      stage.classList.toggle('is-complete', step < controlStep);
      stage.setAttribute('aria-hidden', step <= controlStep ? 'false' : 'true');
    });
    controlSlide.querySelectorAll('.control-connector').forEach((connector, index) => {
      connector.classList.toggle('is-visible', controlStep >= index + 2);
    });
  }

  function updateControls() {
    progressCount.textContent = `${String(current + 1).padStart(2, '0')} / ${String(slides.length).padStart(2, '0')}`;
    const onWorkflow = slides[current] === workflowSlide;
    const onAccuracy = slides[current] === accuracySlide;
    const onControl = slides[current] === controlSlide;
    const onFuture = slides[current] === futureSlide;
    const videoPlaying = slides[current] === demoSlide && isVideoPlaying();
    const atAbsoluteStart = current === 0
      && (!onWorkflow || workflowStep === 0)
      && (!onAccuracy || accuracyStep === 0)
      && (!onControl || controlStep === 1)
      && (!onFuture || futureStep === 0);
    const atAbsoluteEnd = current === slides.length - 1
      && (!onWorkflow || workflowStep >= 4)
      && (!onAccuracy || accuracyStep >= 3)
      && (!onControl || controlStep >= 4)
      && (!onFuture || futureStep >= 3);
    prevButton.disabled = videoPlaying || atAbsoluteStart;
    nextButton.disabled = videoPlaying || atAbsoluteEnd;
    [...progressDots.children].forEach((dot, index) => dot.classList.toggle('is-active', index === current));
    history.replaceState(null, '', `#${current + 1}`);
  }

  function activateInitial() {
    slides.forEach((slide, index) => slide.classList.toggle('is-active', index === current));
    syncWorkflow();
    syncAccuracy();
    syncUsability();
    syncControl();
    syncFuture();
    updateControls();
  }

  function setWorkflowStep(step) {
    if (!workflowSlide || workflowLocked || locked) return false;
    const target = Math.max(0, Math.min(step, 4));
    if (target === workflowStep) return false;
    workflowLocked = true;
    workflowStep = target;
    syncWorkflow();
    updateControls();
    window.setTimeout(() => { workflowLocked = false; }, reduceMotion ? 0 : 580);
    return true;
  }

  function setAccuracyStep(step) {
    if (!accuracySlide || accuracyLocked || locked) return false;
    const target = Math.max(0, Math.min(step, 3));
    if (target === accuracyStep) return false;
    accuracyLocked = true;
    accuracyStep = target;
    syncAccuracy();
    updateControls();
    window.setTimeout(() => { accuracyLocked = false; }, reduceMotion ? 0 : 680);
    return true;
  }

  function setControlStep(step) {
    if (!controlSlide || controlLocked || locked) return false;
    const target = Math.max(1, Math.min(step, 4));
    if (target === controlStep) return false;
    controlLocked = true;
    controlStep = target;
    syncControl();
    updateControls();
    window.setTimeout(() => { controlLocked = false; }, reduceMotion ? 0 : 620);
    return true;
  }

  function syncFuture() {
    if (!futureSlide) return;
    futureSlide.dataset.futureStep = String(futureStep);
    futureSlide.querySelectorAll('.future-node').forEach((node) => {
      const step = Number(node.dataset.futureStep);
      node.classList.toggle('is-visible', step <= futureStep);
      node.classList.toggle('is-active', step === futureStep);
      node.setAttribute('aria-hidden', step <= futureStep ? 'false' : 'true');
    });
    futureSlide.querySelectorAll('.future-connector').forEach((connector, index) => {
      connector.classList.toggle('is-visible', futureStep >= index + 2);
    });
  }

  function setFutureStep(step) {
    if (!futureSlide || futureLocked || locked) return false;
    const target = Math.max(0, Math.min(step, 3));
    if (target === futureStep) return false;
    futureLocked = true;
    futureStep = target;
    syncFuture();
    updateControls();
    window.setTimeout(() => { futureLocked = false; }, reduceMotion ? 0 : 620);
    return true;
  }

  function goTo(index, direction = 'forward') {
    const target = Math.max(0, Math.min(index, slides.length - 1));
    if (target === current || locked || workflowLocked || accuracyLocked || controlLocked || futureLocked || isVideoPlaying()) return;
    locked = true;
    const previous = slides[current];
    const next = slides[target];
    const delay = reduceMotion ? 0 : previous.classList.contains('cover-slide') && direction === 'forward' ? 610 : 360;

    deck.dataset.direction = direction;
    previous.classList.add(direction === 'forward' ? 'is-exiting-forward' : 'is-exiting-back');
    next.classList.add(direction === 'forward' ? 'is-entering-forward' : 'is-entering-back');

    window.setTimeout(() => {
      if (previous === demoSlide) pauseVideoForNavigation();
      previous.classList.remove('is-active', 'is-exiting-forward', 'is-exiting-back');
      previous.setAttribute('aria-hidden', 'true');
      current = target;
      if (next === workflowSlide && !reduceMotion) {
        workflowStep = 0;
        syncWorkflow();
      }
      if (next === accuracySlide && !reduceMotion) {
        accuracyStep = 0;
        syncAccuracy();
      }
      if (next === usabilitySlide) {
        usabilityStep = 4;
        syncUsability();
      }
      if (next === controlSlide && !reduceMotion) {
        controlStep = 1;
        syncControl();
      }
      if (next === futureSlide && !reduceMotion) {
        futureStep = 0;
        syncFuture();
      }
      next.classList.remove('is-entering-forward', 'is-entering-back');
      next.classList.add('is-active');
      next.setAttribute('aria-hidden', 'false');
      updateControls();
      window.setTimeout(() => { locked = false; }, reduceMotion ? 0 : 720);
    }, delay);
  }

  function advance(direction) {
    if (slides[current] === demoSlide && isVideoPlaying()) return;
    const onWorkflow = slides[current] === workflowSlide;
    const onAccuracy = slides[current] === accuracySlide;
    const onControl = slides[current] === controlSlide;
    const onFuture = slides[current] === futureSlide;
    if (onWorkflow) {
      if (direction === 'forward' && workflowStep < 4) {
        setWorkflowStep(workflowStep + 1);
        return;
      }
      if (direction === 'back' && workflowStep > 0) {
        setWorkflowStep(workflowStep - 1);
        return;
      }
    }
    if (onAccuracy) {
      if (direction === 'forward' && accuracyStep < 3) {
        setAccuracyStep(accuracyStep + 1);
        return;
      }
      if (direction === 'back' && accuracyStep > 0) {
        setAccuracyStep(accuracyStep - 1);
        return;
      }
    }
    if (onControl) {
      if (direction === 'forward' && controlStep < 4) {
        setControlStep(controlStep + 1);
        return;
      }
      if (direction === 'back' && controlStep > 1) {
        setControlStep(controlStep - 1);
        return;
      }
    }
    if (onFuture) {
      if (direction === 'forward' && futureStep < 3) {
        setFutureStep(futureStep + 1);
        return;
      }
      if (direction === 'back' && futureStep > 0) {
        setFutureStep(futureStep - 1);
        return;
      }
    }
    goTo(current + (direction === 'forward' ? 1 : -1), direction);
  }

  prevButton.addEventListener('click', () => advance('back'));
  nextButton.addEventListener('click', () => advance('forward'));
  bindVideoControls();

  progressDots.addEventListener('click', (event) => {
    const target = event.target.closest('.progress-dot');
    if (!target) return;
    const index = Number(target.dataset.index);
    goTo(index, index > current ? 'forward' : 'back');
  });

  document.addEventListener('keydown', (event) => {
    if (slides[current] === demoSlide && isVideoPlaying()) {
      if (event.key === ' ') {
        event.preventDefault();
        toggleVideo();
      } else if (['ArrowRight', 'ArrowLeft', 'PageDown', 'PageUp'].includes(event.key)) {
        event.preventDefault();
      }
      return;
    }
    if (slides[current] === demoSlide && event.key === ' ') {
      event.preventDefault();
      toggleVideo();
      return;
    }
    if (['ArrowRight', 'PageDown', ' '].includes(event.key)) {
      event.preventDefault();
      advance('forward');
    } else if (['ArrowLeft', 'PageUp'].includes(event.key)) {
      event.preventDefault();
      advance('back');
    } else if (event.key === 'Home') {
      goTo(0, 'back');
    } else if (event.key === 'End') {
      goTo(slides.length - 1, 'forward');
    } else if (event.key.toLowerCase() === 'f') {
      document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen?.();
    }
  });

  window.addEventListener('wheel', (event) => {
    if (wheelLock || isVideoPlaying() || Math.abs(event.deltaY) < 32) return;
    wheelLock = true;
    advance(event.deltaY > 0 ? 'forward' : 'back');
    window.setTimeout(() => { wheelLock = false; }, 850);
  }, { passive: true });

  window.addEventListener('touchstart', (event) => { touchStartX = event.changedTouches[0].clientX; }, { passive: true });
  window.addEventListener('touchend', (event) => {
    if (isVideoPlaying()) return;
    const distance = event.changedTouches[0].clientX - touchStartX;
    if (Math.abs(distance) < 60) return;
    advance(distance < 0 ? 'forward' : 'back');
  }, { passive: true });

  window.addEventListener('resize', fitDeck);
  fitDeck();
  activateInitial();
})();
