/**
 * app.js —— 遥控 APP 主控制器
 *
 * 职责:
 *   1. 解析 URL (?mock=1) 决定走真蓝牙还是模拟
 *   2. 建两个单轴摇杆 (左=前后, 右=左右)
 *   3. 20Hz 发送循环: 正常发 R<T>,<S>; 急停中发 RX
 *   4. 急停 / 解除 / 直线保持 的 UI 与协议同步
 *   5. 生命周期保护: 切后台立刻发急停
 *
 * ★ 发送策略是"固定 20Hz 一路发", 不是"变了才发".
 *   后者必须额外做心跳来喂 MCU 的 400ms 超时保护, 逻辑更绕;
 *   而典型帧才 7 字节, 20Hz 也就 140 B/s, 9600 波特率根本不用省.
 */

(function () {

    'use strict';

    /* ====================================================================== */
    /*  常量                                                                   */
    /* ====================================================================== */

    var SEND_INTERVAL_MS = 50;      /* 20 Hz */
    var UI_INTERVAL_MS   = 50;      /* UI 跟发送同频刷新 */

    /* ====================================================================== */
    /*  运行状态                                                               */
    /* ====================================================================== */

    var state = {
        throttle: 0,            /* -100 ~ +100 */
        steer:    0,            /* -100 ~ +100 */
        estop:    false,        /* 急停中: 只发 RX */
        hold:     false,        /* 直线保持开关 */
        releaseLeft: 0          /* 解除急停时还要补发几次 RE */
    };

    var isMock = (location.search.indexOf('mock=1') >= 0);

    /* ====================================================================== */
    /*  DOM 引用                                                               */
    /* ====================================================================== */

    var el = {
        status:      document.getElementById('status'),
        valT:        document.getElementById('val-t'),
        valS:        document.getElementById('val-s'),
        valL:        document.getElementById('val-l'),
        valR:        document.getElementById('val-r'),
        btnEstop:    document.getElementById('btn-estop'),
        btnHold:     document.getElementById('btn-hold'),
        btnScan:     document.getElementById('btn-scan'),
        btnDisc:     document.getElementById('btn-disconnect'),

        scanOverlay: document.getElementById('scan-overlay'),
        scanList:    document.getElementById('scan-list'),
        scanTitle:   document.getElementById('scan-title'),
        scanClose:   document.getElementById('scan-close'),

        mockpanel:   document.getElementById('mockpanel'),
        mocklog:     document.getElementById('mock-log'),
        mockrate:    document.getElementById('mock-rate')
    };

    /* ====================================================================== */
    /*  摇杆                                                                   */
    /* ====================================================================== */

    var jkThrottle = new Joystick(
        document.getElementById('jk-throttle'),
        'y',
        function (v) { state.throttle = v; }
    );

    var jkSteer = new Joystick(
        document.getElementById('jk-steer'),
        'x',
        function (v) { state.steer = v; }
    );

    /* ====================================================================== */
    /*  状态显示                                                               */
    /* ====================================================================== */

    function setStatus(kind, text) {
        el.status.textContent = text;
        el.status.className = 'status status--' + kind;
    }

    function updateEstopBtn() {
        if (state.estop) {
            el.btnEstop.textContent = '已急停 · 点此解除';
            el.btnEstop.classList.add('is-on');
        } else {
            el.btnEstop.textContent = '急 停';
            el.btnEstop.classList.remove('is-on');
        }
    }

    function updateHoldBtn() {
        el.btnHold.textContent = '直线保持：' + (state.hold ? '开' : '关');
        if (state.hold) el.btnHold.classList.add('is-on');
        else            el.btnHold.classList.remove('is-on');
    }

    /* 把 -100~+100 的浮点显示成带符号两位整数, 例如 "+50" / "-07" / "  0" */
    function fmtStick(v) {
        var n = Math.round(v);
        var a = (n < 0) ? -n : n;
        var s = (a < 10 ? '0' : '') + a;
        return (n > 0 ? '+' : (n < 0 ? '-' : ' ')) + s;
    }

    function fmtDuty(v) {
        var n = Math.round(v);
        var a = (n < 0) ? -n : n;
        var s = (a < 10 ? '00' : (a < 100 ? '0' : '')) + a;
        return (n > 0 ? '+' : (n < 0 ? '-' : ' ')) + s;
    }

    /* ====================================================================== */
    /*  整车反向行驶                                                           */
    /*                                                                         */
    /*  这辆车驱动轮装在车头, 重心压在万向轮那一端, 驱动轮分到的法向载荷小.    */
    /*  前进时纵向载荷转移又把重心甩向尾部、驱动轮再卸载一层, 车速一高, 差速    */
    /*  转向需要的纵向力就超过 μN, 驱动轮开始打滑. 打滑的后果不是"转不动",     */
    /*  而是那一侧的有效推力反而下降, 车往命令的反方向偏 —— 负反馈变正反馈,    */
    /*  表现就是"跑着跑着突然一个大甩尾".                                      */
    /*  倒车时惯性力向前, 重心压回驱动轮, 抓地力足, 越野都不虚.                */
    /*                                                                         */
    /*  所以干脆让整车一直反着开: **只在发帧这一处**把 T 取反.                 */
    /*  摇杆方向、屏幕上的数值、混控预览全部按用户视角走 ——                     */
    /*  用户在 APP 上"往上推 = 车往前", 而物理上那其实是倒车.                  */
    /*                                                                         */
    /*  ★ 这个翻转只此一处, 别在 joystick.js 或 protocol.js 里再翻一次,        */
    /*    两次就抵消回去了.                                                    */
    /*  ★ 如果哪天把重心挪到驱动轴上了, 把这里改成 return v; 就切回正向.       */
    /* ====================================================================== */

    function physThrottle(v) {
        return -v;
    }

    function updateUI() {
        el.valT.textContent = fmtStick(state.throttle);
        el.valS.textContent = fmtStick(state.steer);

        /* 混控预览: 和 MCU 端 Remote.c 的算法逐位一致, 但不含直线保持修正.
         * 输入必须是 physThrottle() 翻转之后的值 —— MCU 收到的是翻转后的 T,
         * 预览跟它用同一套输入才对得上. */
        var m = Protocol.mix(physThrottle(state.throttle), state.steer);
        el.valL.textContent = fmtDuty(m.left);
        el.valR.textContent = fmtDuty(m.right);
    }

    /* ====================================================================== */
    /*  BLE 回调                                                               */
    /* ====================================================================== */

    function onStatus(kind, text) {
        /* kind: ready / mock / error / connecting / disconnected / ... */
        var cls = 'idle';
        if (kind === 'ready' || kind === 'connected') cls = 'ok';
        else if (kind === 'mock')                    cls = 'mock';
        else if (kind === 'error')                   cls = 'error';
        else if (kind === 'connecting')              cls = 'idle';

        setStatus(cls, text);

        if (kind === 'ready' || kind === 'mock') {
            /* ★ 连上之后先补一帧 RE 解开可能残留的急停锁存.
             *
             * 场景: 用户按着急停 / 切了后台, APP 被杀掉. MCU 那边
             * Remote_AppEStop_Flag 是**锁存**的, 主控制帧解不开它,
             * 所以重连之后如果只发主控帧, 车会一动不动, 而 APP 这边
             * 看起来一切正常 —— 用户会以为 APP 坏了.
             *
             * 主动连上 = 想控制, 所以这里发一次 RE 是合理的. 此刻摇杆
             * 必然是 0 (刚连上), 发出去的下一帧就是 R0,0, 车不会乱动. */
            BLE.send(Protocol.FRAME_RELEASE);
            BLE.send(Protocol.frameHold(state.hold));
        }
    }

    function onDevices(list) {
        /* ★ 空列表也要把浮层显示出来 —— 显示"扫描中"或"未发现设备",
         *   而不是什么都不出现. 第一版是"列表空就直接 hidden", 结果
         *   用户看到的就是"点扫描没反应". */
        el.scanOverlay.classList.remove('hidden');

        if (!list || !list.length) {
            el.scanTitle.textContent = '蓝牙设备';
            el.scanList.innerHTML = BLE.isScanning()
                ? '<div class="scan-empty">正在扫描…<br>请确认小车已上电、指示灯在闪</div>'
                : '<div class="scan-empty">未发现设备<br>再点一次「扫描设备」重试</div>';
            return;
        }

        el.scanTitle.textContent = '蓝牙设备 (' + list.length + ')';

        var html = '';
        for (var i = 0; i < list.length; i++) {
            var d = list[i];
            html += '<div class="scan-item" data-id="' + d.deviceId + '">'
                  +   '<span class="scan-name">' + (d.name || '未知设备') + '</span>'
                  +   '<span class="scan-rssi">' + d.rssi + ' dBm</span>'
                  + '</div>';
        }
        el.scanList.innerHTML = html;

        /* 点击连接 */
        var items = el.scanList.querySelectorAll('.scan-item');
        for (var j = 0; j < items.length; j++) {
            items[j].addEventListener('click', function () {
                var id = this.getAttribute('data-id');
                BLE.stopScan();
                el.scanOverlay.classList.add('hidden');
                setStatus('idle', '正在连接...');
                BLE.connect(id);
            });
        }
    }

    /* ====================================================================== */
    /*  按钮                                                                   */
    /* ====================================================================== */

    el.btnEstop.addEventListener('click', function () {
        if (state.estop) {
            /* 解除: 先补发几次 RE 打通锁存, 再恢复发主控制帧.
             * 顺序不能反 —— 主控制帧解不开 MCU 那边的急停锁存. */
            state.estop = false;
            state.releaseLeft = 3;
        } else {
            state.estop = true;
            jkThrottle.reset();
            jkSteer.reset();
            state.throttle = 0;
            state.steer = 0;
        }
        updateEstopBtn();
    });

    el.btnHold.addEventListener('click', function () {
        state.hold = !state.hold;
        updateHoldBtn();
        if (BLE.isConnected()) {
            BLE.send(Protocol.frameHold(state.hold));
        }
    });

    el.btnScan.addEventListener('click', function () {
        /* 先弹浮层再开始扫描 —— 让用户立刻看到反应 */
        el.scanOverlay.classList.remove('hidden');
        el.scanTitle.textContent = '蓝牙设备';
        el.scanList.innerHTML = '<div class="scan-empty">正在扫描…</div>';
        BLE.scan();
    });

    el.scanClose.addEventListener('click', function () {
        BLE.stopScan();
        el.scanOverlay.classList.add('hidden');
    });

    /* 点浮层空白处关闭 */
    el.scanOverlay.addEventListener('click', function (e) {
        if (e.target === el.scanOverlay) {
            BLE.stopScan();
            el.scanOverlay.classList.add('hidden');
        }
    });

    el.btnDisc.addEventListener('click', function () {
        BLE.disconnect();
        setStatus('idle', '已断开');
    });

    /* ====================================================================== */
    /*  发送循环 (20Hz)                                                        */
    /* ====================================================================== */

    function sendTick() {
        if (!BLE.isConnected()) return;

        if (state.estop) {
            BLE.send(Protocol.FRAME_ESTOP);
            return;
        }

        if (state.releaseLeft > 0) {
            BLE.send(Protocol.FRAME_RELEASE);
            state.releaseLeft--;
            return;
        }

        /* 整车反向行驶: 发出去的 T 是翻转过的, 见 physThrottle() */
        BLE.send(Protocol.frameMove(physThrottle(state.throttle), state.steer));
    }

    /* ====================================================================== */
    /*  UI 刷新循环                                                            */
    /* ====================================================================== */

    function uiTick() {
        updateUI();

        if (isMock) {
            /* MOCK 面板: 显示最近几帧 + 实时速率 */
            var log = BLE.getMockLog();
            el.mocklog.textContent = log.slice(-8).join('');

            var st = BLE.takeTxStats();
            if (st.fps > 0) {
                el.mockrate.textContent =
                    st.fps.toFixed(1) + ' Hz / ' + st.bps.toFixed(0) + ' B/s';
            }
        }
    }

    /* ====================================================================== */
    /*  生命周期保护                                                           */
    /*                                                                        */
    /*  切后台 / 锁屏 / 来电时立刻发急停锁存. 即使这段失效, MCU 端 400ms      */
    /*  超时也会兜底 —— 双层保险.                                             */
    /* ====================================================================== */

    function safeStop() {
        state.estop = true;
        jkThrottle.reset();
        jkSteer.reset();
        state.throttle = 0;
        state.steer = 0;
        updateEstopBtn();

        /* 连发两帧 RX, 提高送达概率 */
        if (BLE.isConnected()) {
            BLE.send(Protocol.FRAME_ESTOP);
            BLE.send(Protocol.FRAME_ESTOP);
        }
    }

    document.addEventListener('visibilitychange', function () {
        if (document.hidden) safeStop();
    });
    window.addEventListener('pagehide', safeStop);

    /* 防止双指缩放 / 双击放大 */
    document.addEventListener('gesturestart', function (e) { e.preventDefault(); });
    document.addEventListener('dblclick',      function (e) { e.preventDefault(); });

    /* ====================================================================== */
    /*  启动                                                                   */
    /*                                                                        */
    /*  ★ 关键: HBuilder 的 plus API 必须等 plusready 事件之后才能调.          */
    /*    App 启动时脚本是立刻就执行的, 那一刻 window.plus 还不存在,           */
    /*    如果这时调 BLE.init(), hasPlus() 返回 false, 初始化直接放弃 ——       */
    /*    表现就是"点扫描没任何反应". 原来的 TreiBlue 模板里就有这个监听.      */
    /* ====================================================================== */

    var bleStarted = false;

    function startBLE() {
        if (bleStarted) return;
        bleStarted = true;
        BLE.init(onStatus, onDevices);
    }

    function boot() {
        updateEstopBtn();
        updateHoldBtn();
        updateUI();

        if (isMock) {
            BLE.setMock(true);
            el.mockpanel.classList.remove('hidden');
            startBLE();
        } else if (window.plus) {
            /* 页面加载偏慢时 plusready 可能已经触发过了, 直接启动 */
            startBLE();
        } else {
            /* 正常路径: 等 plusready */
            document.addEventListener('plusready', startBLE, false);

            /* 兜底: 极少数环境下 plusready 不触发但 plus 其实已经就绪.
             * 每 500ms 探一次, 最多探 20 次 (10 秒), 探到就启动;
             * 一直探不到也照样启动, 让 BLE.init 走 no-h5plus 分支把
             * 错误显示到状态栏, 而不是静默什么都不做. */
            var tries = 0;
            var probe = setInterval(function () {
                tries++;
                if (window.plus) {
                    clearInterval(probe);
                    startBLE();
                } else if (tries >= 20) {
                    clearInterval(probe);
                    startBLE();
                }
            }, 500);
        }

        setInterval(sendTick, SEND_INTERVAL_MS);
        setInterval(uiTick,   UI_INTERVAL_MS);
    }

    boot();

})();
