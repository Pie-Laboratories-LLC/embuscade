// Mesh voice chat: one RTCPeerConnection per other human player in the same
// game, signaled through the existing game WebSocket (see 'voice-signal' in
// server.js). Uses the "Perfect Negotiation" pattern (see MDN) so either side
// can safely (re)negotiate -- needed because local media may become available
// (mic permission granted, or the local player un-mutes) well after peer
// connections already exist.

const ICE_SERVERS = [{ urls: 'stun:stun.l.google.com:19302' }];

// Voice-activity detection: a simple RMS-over-threshold check on each
// talker's audio stream, with a hold time so brief dips between syllables
// don't flicker the "talking" indicator on and off.
const TALK_RMS_THRESHOLD = 0.02;
const TALK_HOLD_MS = 400;

export function createVoiceChat({ onSignal, onLog, onTalkingChange }) {
    let selfId = null;
    let localStream = null;
    let localEnabled = false;
    let pendingLocalStream = null;
    const peers = new Map(); // playerId -> { pc, audioEl, polite, makingOffer, ignoreOffer }

    let audioCtx = null;
    const talkers = new Map(); // id -> { source, analyser, dataArray, isTalking, lastLoudAt }
    let vadRafId = null;

    function log(...args) {
        if (onLog) onLog(...args);
    }

    function getAudioContext() {
        if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        return audioCtx;
    }

    function watchTalking(id, stream) {
        unwatchTalking(id);
        if (!stream || stream.getAudioTracks().length === 0) return;

        const ctx = getAudioContext();
        const source = ctx.createMediaStreamSource(stream);
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 512;
        analyser.smoothingTimeConstant = 0.5;
        source.connect(analyser);

        talkers.set(id, {
            source,
            analyser,
            dataArray: new Uint8Array(analyser.frequencyBinCount),
            isTalking: false,
            lastLoudAt: 0
        });

        if (!vadRafId) vadRafId = requestAnimationFrame(vadTick);
    }

    function unwatchTalking(id) {
        const talker = talkers.get(id);
        if (!talker) return;
        talker.source.disconnect();
        talkers.delete(id);
        if (talker.isTalking && onTalkingChange) onTalkingChange(id, false);
    }

    function vadTick() {
        const now = performance.now();
        for (const [id, talker] of talkers) {
            talker.analyser.getByteTimeDomainData(talker.dataArray);

            let sumSquares = 0;
            for (let i = 0; i < talker.dataArray.length; i++) {
                const sample = (talker.dataArray[i] - 128) / 128;
                sumSquares += sample * sample;
            }
            const rms = Math.sqrt(sumSquares / talker.dataArray.length);
            if (rms > TALK_RMS_THRESHOLD) talker.lastLoudAt = now;

            const shouldBeTalking = (now - talker.lastLoudAt) < TALK_HOLD_MS;
            if (shouldBeTalking !== talker.isTalking) {
                talker.isTalking = shouldBeTalking;
                if (onTalkingChange) onTalkingChange(id, shouldBeTalking);
            }
        }
        vadRafId = talkers.size > 0 ? requestAnimationFrame(vadTick) : null;
    }

    function makeAudioEl() {
        const el = document.createElement('audio');
        el.autoplay = true;
        el.style.display = 'none';
        document.body.appendChild(el);
        return el;
    }

    function attachLocalTracks(peer) {
        if (!localStream) return;
        const attached = new Set(peer.pc.getSenders().map(s => s.track));
        for (const track of localStream.getAudioTracks()) {
            if (!attached.has(track)) peer.pc.addTrack(track, localStream);
        }
    }

    function applyLocalEnabled() {
        if (!localStream) return;
        for (const track of localStream.getAudioTracks()) {
            track.enabled = localEnabled;
        }
    }

    async function ensureLocalStream() {
        if (localStream) return localStream;
        if (pendingLocalStream) return pendingLocalStream;

        if (!navigator.mediaDevices?.getUserMedia) {
            log('getUserMedia not available in this browser/context');
            return null;
        }

        pendingLocalStream = navigator.mediaDevices.getUserMedia({ audio: true, video: false })
            .then((stream) => {
                localStream = stream;
                applyLocalEnabled();
                for (const peer of peers.values()) attachLocalTracks(peer);
                return stream;
            })
            .catch((err) => {
                log('microphone unavailable:', err.message ?? err);
                return null;
            })
            .finally(() => { pendingLocalStream = null; });

        return pendingLocalStream;
    }

    function createPeer(remoteId) {
        const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
        const audioEl = makeAudioEl();
        const peer = { pc, audioEl, polite: selfId > remoteId, makingOffer: false, ignoreOffer: false };
        peers.set(remoteId, peer);

        pc.onnegotiationneeded = async () => {
            try {
                peer.makingOffer = true;
                await pc.setLocalDescription();
                onSignal(remoteId, { description: pc.localDescription });
            } catch (err) {
                log(`negotiation error with ${remoteId}:`, err.message ?? err);
            } finally {
                peer.makingOffer = false;
            }
        };

        pc.onicecandidate = ({ candidate }) => {
            if (candidate) onSignal(remoteId, { candidate });
        };

        pc.ontrack = (event) => {
            audioEl.srcObject = event.streams[0];
            watchTalking(remoteId, event.streams[0]);
        };

        pc.onconnectionstatechange = () => {
            log(`peer ${remoteId} connection state: ${pc.connectionState}`);
        };

        if (localStream) attachLocalTracks(peer);

        return peer;
    }

    function destroyPeer(remoteId) {
        const peer = peers.get(remoteId);
        if (!peer) return;
        unwatchTalking(remoteId);
        peer.pc.close();
        peer.audioEl.srcObject = null;
        peer.audioEl.remove();
        peers.delete(remoteId);
    }

    function setSelfId(id) {
        selfId = id;
    }

    function setPeers(peerIds) {
        const wanted = new Set(peerIds.filter((id) => id !== selfId && id !== null && id !== undefined));

        for (const id of Array.from(peers.keys())) {
            if (!wanted.has(id)) destroyPeer(id);
        }
        for (const id of wanted) {
            if (!peers.has(id)) createPeer(id);
        }
    }

    async function setLocalEnabled(enabled) {
        localEnabled = enabled;

        if (enabled) {
            const stream = await ensureLocalStream();
            // localEnabled may have flipped back off while awaiting mic permission.
            if (stream && localEnabled && selfId !== null) watchTalking(selfId, stream);
        } else if (selfId !== null) {
            unwatchTalking(selfId);
        }

        applyLocalEnabled();
    }

    async function handleSignal(fromId, signal) {
        let peer = peers.get(fromId);
        if (!peer) peer = createPeer(fromId);
        const { pc } = peer;

        try {
            if (signal.description) {
                const offerCollision = signal.description.type === 'offer'
                    && (peer.makingOffer || pc.signalingState !== 'stable');
                peer.ignoreOffer = !peer.polite && offerCollision;
                if (peer.ignoreOffer) return;

                await pc.setRemoteDescription(signal.description);
                if (signal.description.type === 'offer') {
                    await pc.setLocalDescription();
                    onSignal(fromId, { description: pc.localDescription });
                }
            } else if (signal.candidate) {
                try {
                    await pc.addIceCandidate(signal.candidate);
                } catch (err) {
                    if (!peer.ignoreOffer) throw err;
                }
            }
        } catch (err) {
            log(`signal handling error with ${fromId}:`, err.message ?? err);
        }
    }

    function teardownAll() {
        for (const id of Array.from(peers.keys())) destroyPeer(id);
        for (const id of Array.from(talkers.keys())) unwatchTalking(id);
        if (localStream) {
            for (const track of localStream.getTracks()) track.stop();
            localStream = null;
        }
    }

    return { setSelfId, setPeers, setLocalEnabled, handleSignal, teardownAll };
}
