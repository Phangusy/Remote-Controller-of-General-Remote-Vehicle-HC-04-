/**
 * ble.js —— BLE 蓝牙串口封装
 *
 * 基于 DCloud HTML5+ plus.bluetooth API。
 * 调用序列完全照搬已验证跑通的 `D:\BlueMap\TreiBlue\js\ble.js`:
 *   getBluetoothAdapterState → (失败则 openBluetoothAdapter)
 *   → startBluetoothDevicesDiscovery → onBluetoothDeviceFound
 *   → createBLEConnection → getBLEDeviceServices (找 FFE0)
 *   → getBLEDeviceCharacteristics (找 FFE1)
 *   → notifyBLECharacteristicValueChange
 *
 * 与 TreiBlue 的差别 (只有三处):
 *   1. 不需要解析 MCU 回传的遥测 (遥控模式不回传任何东西)
 *   2. localStorage 的 key 换了名字
 *   3. 增加了 MOCK 模式, 方便车不在手边时在浏览器里验证 UI 和协议
 *
 * ============================================================================
 *  MOCK 模式
 * ============================================================================
 *  地址栏加 `?mock=1` 即可:
 *    - 不调用任何 plus API (浏览器里也能跑)
 *    - isConnected() 恒为 true
 *    - send() 把帧写进 window.__mockLog 和页面上的调试面板
 *  用来验证: 摇杆手感 / 帧格式 / 发送频率 / 急停逻辑。
 */

var BLE = (function () {

    /* ====================================================================== */
    /*  内部状态                                                               */
    /* ====================================================================== */
    var S = {
        mock:        false,
        available:   false,
        connected:   false,
        scanning:    false,
        scanTimer:   null,      /* getBluetoothDevices 轮询定时器 */
        deviceId:    null,
        serviceId:   null,
        charId:      null,
        devices:     {},
        statusCb:    null,
        listCb:      null,
        mockLog:     [],
        txCount:     0,
        txBytes:     0,
        txWindowTs:  0      /* 用于算实时帧率的窗口起点 */
    };

    var UUID_SERVICE = '0000FFE0-0000-1000-8000-00805F9B34FB';
    var UUID_CHAR    = '0000FFE1-0000-1000-8000-00805F9B34FB';
    var LS_KEY       = 'treiwagon_remote_device';

    /* ====================================================================== */
    /*  工具                                                                   */
    /* ====================================================================== */
    function notifyStatus(state, text) {
        if (S.statusCb) S.statusCb(state, text);
    }

    function hasPlus() {
        return (typeof plus !== 'undefined') && plus && plus.bluetooth;
    }

    /* ====================================================================== */
    /*  初始化                                                                 */
    /*                                                                        */
    /*  @param {function} statusCb  function(state, text) 状态回调            */
    /*  @param {function} listCb    function(devices)    设备列表回调         */
    /* ====================================================================== */
    function init(statusCb, listCb) {
        S.statusCb = statusCb;
        S.listCb   = listCb;

        /* ---- MOCK 模式: 由 app.js 在解析完 URL 后显式开启 ---- */
        if (S.mock) {
            S.available = true;
            S.connected = true;
            notifyStatus('mock', '模拟模式（未连真蓝牙）');
            return;
        }

        if (!hasPlus()) {
            S.available = false;
            notifyStatus('no-h5plus', '当前环境没有蓝牙能力（浏览器请加 ?mock=1）');
            return;
        }

        plus.bluetooth.getBluetoothAdapterState({
            success: function (res) {
                if (res.available) {
                    S.available = true;
                    notifyStatus('ready', '蓝牙已就绪');
                    var lastId = localStorage.getItem(LS_KEY);
                    if (lastId) connect(lastId);
                } else {
                    S.available = false;
                    notifyStatus('error', '蓝牙适配器不可用，请先打开手机蓝牙');
                }
            },
            fail: function (err) {
                /* "not init" 之类 → 尝试重新打开适配器 */
                if (err && (err.code === -1
                        || (err.message && err.message.indexOf('not init') >= 0))) {
                    reopenAdapter();
                } else {
                    S.available = false;
                    notifyStatus('error', '蓝牙初始化失败: ' + JSON.stringify(err));
                }
            }
        });
    }

    function reopenAdapter() {
        plus.bluetooth.openBluetoothAdapter({
            success: function () {
                S.available = true;
                notifyStatus('ready', '蓝牙已重新打开');
            },
            fail: function (err) {
                S.available = false;
                notifyStatus('error', '蓝牙打开失败: ' + JSON.stringify(err));
            }
        });
    }

    /* ====================================================================== */
    /*  扫描                                                                   */
    /*                                                                        */
    /*  ★ 两条路一起走:                                                        */
    /*    ① onBluetoothDeviceFound  事件回调 —— 发现新设备就推                */
    /*    ② getBluetoothDevices     主动拉缓存 —— 定时轮询                    */
    /*  只靠 ① 是不够的: 在某些机型 / HBuilderX 版本上那个回调根本不触发,      */
    /*  结果就是扫描转了一圈什么都没拿到. 原来的 TreiBlue 就是靠 ② 兜住的,     */
    /*  我第一版把 ② 删了, 于是"点扫描没反应".                                 */
    /* ====================================================================== */

    /** 把 plus 缓存里已有的设备合并进 S.devices, 有新增就回调 */
    function pullCachedDevices() {
        if (!hasPlus()) return;

        plus.bluetooth.getBluetoothDevices({
            success: function (res) {
                var grew = false;
                var list = (res && res.devices) ? res.devices : [];

                for (var i = 0; i < list.length; i++) {
                    var d = list[i];
                    if (!d || !d.deviceId) continue;
                    if (!S.devices[d.deviceId]) grew = true;
                    S.devices[d.deviceId] = d;
                }

                if (grew && S.listCb) S.listCb(getDevices());
            },
            fail: function () { /* 静默: 轮询失败不代表扫描失败, 下次再拉 */ }
        });
    }

    function scan() {
        if (S.mock) {
            /* MOCK 模式给两个假设备, 方便验证列表 UI */
            S.devices = {
                'MOCK-HC04': { name: 'HC-04 (模拟)', RSSI: -55 },
                'MOCK-HM10': { name: 'HM-10 (模拟)', RSSI: -70 }
            };
            S.scanning = false;
            if (S.listCb) S.listCb(getDevices());
            notifyStatus('scanned', '模拟扫描完成');
            return;
        }

        if (S.scanning) return;
        if (!hasPlus()) {
            notifyStatus('error', '当前环境不支持蓝牙扫描');
            return;
        }

        S.devices  = {};
        S.scanning = true;
        notifyStatus('scanning', '正在扫描...');

        /* 先把空列表推出去, 让 UI 立刻显示"空列表 + 扫描中", 而不是干等着 */
        if (S.listCb) S.listCb([]);

        plus.bluetooth.openBluetoothAdapter({
            success: function () {
                S.available = true;

                /* ① 事件回调 */
                plus.bluetooth.onBluetoothDeviceFound(function (devices) {
                    if (!devices || !devices.length) return;
                    for (var i = 0; i < devices.length; i++) {
                        var d = devices[i];
                        if (d && d.deviceId) S.devices[d.deviceId] = d;
                    }
                    if (S.listCb) S.listCb(getDevices());
                });

                plus.bluetooth.startBluetoothDevicesDiscovery({
                    services: [],
                    allowDuplicatesKey: true,
                    interval: 2000,
                    success: function () {
                        /* ② 立即拉一次, 之后每 1.5 秒拉一次 */
                        pullCachedDevices();
                        if (S.scanTimer) clearInterval(S.scanTimer);
                        S.scanTimer = setInterval(function () {
                            if (!S.scanning) { clearInterval(S.scanTimer); S.scanTimer = null; return; }
                            pullCachedDevices();
                        }, 1500);

                        /* 30 秒后自动停止, 省电 */
                        setTimeout(function () {
                            if (S.scanning) stopScan();
                        }, 30000);
                    },
                    fail: function (err) {
                        S.scanning = false;
                        if (S.scanTimer) { clearInterval(S.scanTimer); S.scanTimer = null; }
                        notifyStatus('error', '扫描启动失败: ' + JSON.stringify(err));
                    }
                });
            },
            fail: function (err) {
                S.scanning = false;
                notifyStatus('error', '适配器打开失败: ' + JSON.stringify(err));
            }
        });
    }

    function stopScan() {
        if (S.mock) return;

        if (S.scanTimer) { clearInterval(S.scanTimer); S.scanTimer = null; }
        if (!S.scanning) return;

        S.scanning = false;
        if (hasPlus()) plus.bluetooth.stopBluetoothDevicesDiscovery({});
        notifyStatus('scanned', '扫描完成');
        if (S.listCb) S.listCb(getDevices());
    }

    function getDevices() {
        var list = [];
        for (var id in S.devices) {
            var d = S.devices[id];
            list.push({
                deviceId: id,
                name: d.name || d.localName || '未知设备',
                rssi: d.RSSI || 0
            });
        }
        list.sort(function (a, b) { return b.rssi - a.rssi; });
        return list;
    }

    /* ====================================================================== */
    /*  连接                                                                   */
    /*                                                                        */
    /*  @param {string} deviceId                                              */
    /* ====================================================================== */
    function connect(deviceId) {
        if (S.mock) {
            S.deviceId  = deviceId;
            S.connected = true;
            notifyStatus('ready', '模拟已连接: ' + deviceId);
            return;
        }

        if (!S.available) {
            notifyStatus('error', '蓝牙不可用');
            return;
        }
        if (!hasPlus()) {
            notifyStatus('error', '当前环境不支持蓝牙连接');
            return;
        }
        if (S.connected) disconnect();

        S.deviceId = deviceId;
        localStorage.setItem(LS_KEY, deviceId);
        notifyStatus('connecting', '正在连接...');

        plus.bluetooth.createBLEConnection({
            deviceId: deviceId,
            success: function () { getServices(deviceId); },
            fail: function (err) {
                notifyStatus('error', '连接失败: ' + JSON.stringify(err));
            }
        });
    }

    function getServices(deviceId) {
        plus.bluetooth.getBLEDeviceServices({
            deviceId: deviceId,
            success: function (res) {
                var list = (res && res.services) ? res.services : [];
                var svc  = null;

                /* 优先精确匹配 FFE0 */
                for (var i = 0; i < list.length; i++) {
                    if (list[i].uuid.toLowerCase() === UUID_SERVICE.toLowerCase()) {
                        svc = list[i];
                        break;
                    }
                }
                /* 降级: 用第一个 */
                if (!svc && list.length > 0) svc = list[0];
                if (!svc) {
                    notifyStatus('error', '未找到可用服务');
                    return;
                }

                S.serviceId = svc.uuid;
                getCharacteristics(deviceId, svc.uuid);
            },
            fail: function (err) {
                notifyStatus('error', '获取服务失败: ' + JSON.stringify(err));
            }
        });
    }

    function getCharacteristics(deviceId, serviceId) {
        plus.bluetooth.getBLEDeviceCharacteristics({
            deviceId: deviceId,
            serviceId: serviceId,
            success: function (res) {
                var list = (res && res.characteristics) ? res.characteristics : [];
                var chr  = null;

                /* 优先精确匹配 FFE1, 其次找可写/可通知的, 最后降级用第一个 */
                for (var i = 0; i < list.length; i++) {
                    if (list[i].uuid.toLowerCase() === UUID_CHAR.toLowerCase()) {
                        chr = list[i];
                        break;
                    }
                }
                if (!chr) {
                    for (var j = 0; j < list.length; j++) {
                        var p = list[j].properties || {};
                        if (p.notify || p.indicate) { chr = list[j]; break; }
                    }
                }
                if (!chr && list.length > 0) chr = list[0];
                if (!chr) {
                    notifyStatus('error', '未找到可用特征值');
                    return;
                }

                S.charId = chr.uuid;
                enableNotify(deviceId, serviceId, chr.uuid);
            },
            fail: function (err) {
                notifyStatus('error', '获取特征值失败: ' + JSON.stringify(err));
            }
        });
    }

    function enableNotify(deviceId, serviceId, charId) {
        plus.bluetooth.notifyBLECharacteristicValueChange({
            deviceId: deviceId,
            serviceId: serviceId,
            characteristicId: charId,
            state: true,
            success: function () {
                S.connected = true;
                notifyStatus('ready', '已连接');

                /* 遥控模式 MCU 不回传, 但有些模块必须订阅之后才允许 write,
                 * 所以这里保留订阅, 回调里什么都不做 */
                plus.bluetooth.onBLECharacteristicValueChange(function () {});
            },
            fail: function (err) {
                /* 订阅通知失败**不影响 write** —— write 和 notify 是两个独立的
                 * 特征属性, 而且遥控模式 MCU 本来就不回传, 订不订阅都一样.
                 * 所以照样标记已连接, 但把错误报出来让用户知道.
                 *
                 * ★ 早先的版本这里只报错不置 connected, 结果订阅一失败
                 *   整条发送通道就被掐死了 —— 车一帧都收不到, 而 UI 还显示着
                 *   "连接中". 那是最坏的一种失败: 静默. */
                S.connected = true;
                notifyStatus('ready', '已连接（通知订阅失败，不影响发送）');
            }
        });
    }

    /* ====================================================================== */
    /*  断开                                                                   */
    /* ====================================================================== */
    function disconnect() {
        if (S.mock) {
            S.connected = false;
            notifyStatus('disconnected', '模拟已断开');
            return;
        }
        if (!S.deviceId) return;

        if (hasPlus() && S.available) {
            plus.bluetooth.closeBLEConnection({ deviceId: S.deviceId });
        }
        S.connected = false;
        S.deviceId  = null;
        S.serviceId = null;
        S.charId    = null;
        notifyStatus('disconnected', '已断开');
    }

    /* ====================================================================== */
    /*  发送                                                                   */
    /*                                                                        */
    /*  @param  {string} text  要发送的 ASCII 文本                            */
    /*  @return {boolean}      是否成功送出                                   */
    /* ====================================================================== */
    function send(text) {
        /* ---- 统计 (MOCK 和真机都算) ---- */
        S.txCount++;
        S.txBytes += text.length;

        if (S.mock) {
            S.mockLog.push(text);
            if (S.mockLog.length > 40) S.mockLog.shift();
            return true;
        }

        if (!S.connected || !S.deviceId || !S.charId) return false;
        if (!hasPlus()) return false;

        /* ASCII → ArrayBuffer. 我们的帧最长 11 字节, 远小于 BLE 单包 20 字节,
         * 不需要分包. */
        var buf  = new ArrayBuffer(text.length);
        var view = new Uint8Array(buf);
        for (var i = 0; i < text.length; i++) {
            view[i] = text.charCodeAt(i) & 0xFF;
        }

        plus.bluetooth.writeBLECharacteristicValue({
            deviceId: deviceIdSafe(),
            serviceId: S.serviceId,
            characteristicId: S.charId,
            value: buf,
            success: function () {},
            fail: function (err) {
                notifyStatus('error', '发送失败: ' + JSON.stringify(err));
            }
        });
        return true;
    }

    function deviceIdSafe() { return S.deviceId; }

    /* ====================================================================== */
    /*  状态查询                                                               */
    /* ====================================================================== */
    return {
        init:        init,
        scan:        scan,
        stopScan:    stopScan,
        connect:     connect,
        disconnect:  disconnect,
        send:        send,
        getDevices:  getDevices,

        isConnected: function () { return S.connected; },
        isAvailable: function () { return S.available; },
        isMock:      function () { return S.mock; },
        isScanning:  function () { return S.scanning; },

        setMock: function (on) { S.mock = !!on; },
        getMockLog: function () { return S.mockLog.slice(); },

        /* 取一次发送统计并清零计数, 用于算实时帧率 */
        takeTxStats: function () {
            var now = Date.now();
            var span = (S.txWindowTs > 0) ? (now - S.txWindowTs) / 1000 : 0;
            var res = {
                count: S.txCount,
                bytes: S.txBytes,
                span:  span,
                fps:   (span > 0.2) ? (S.txCount / span) : 0,
                bps:   (span > 0.2) ? (S.txBytes / span) : 0
            };
            S.txCount    = 0;
            S.txBytes    = 0;
            S.txWindowTs = now;
            return res;
        }
    };
})();
