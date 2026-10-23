/**
 * protocol.js —— 遥控协议编解码 + 混控预览
 *
 * ★ 本文件与 MCU 端 `Remote.c` / `Remote.h` 严格对齐，任何一个数字
 *   改了都必须两边一起改。`HALF/verify_remote_protocol.py` 会逐帧对拍。
 *
 * 帧格式 (APP → MCU, 纯 ASCII, 以 \n 结尾):
 *   R<T>,<S>   主控制帧, T=油门 -100~+100, S=转向 -100~+100
 *   RX         紧急停止 (MCU 端锁存)
 *   RE         解除急停
 *   RH0 / RH1  直线保持 关 / 开
 */

var Protocol = (function () {

    /* ====================================================================== */
    /*  与 Remote.h 里的宏逐一对应 —— 改这里必须同步改 Remote.h               */
    /* ====================================================================== */
    var SPEC = {
        STICK_DEADZONE: 3.0,    /* REMOTE_STICK_DEADZONE  */
        MIN_DUTY:       15.0,   /* REMOTE_MIN_DUTY        */
        TURN_MAX:       100.0   /* REMOTE_TURN_MAX        */
    };

    /* 固定帧 */
    var FRAME_ESTOP   = 'RX\n';
    var FRAME_RELEASE = 'RE\n';
    var FRAME_HOLD_ON  = 'RH1\n';
    var FRAME_HOLD_OFF = 'RH0\n';

    /* ====================================================================== */
    /*  数值处理                                                               */
    /* ====================================================================== */

    /**
     * clampStick —— 把摇杆值钳到 -100~+100 并取整
     *
     * 取整在 APP 侧做, MCU 端收到的一定是整数。
     * 注意 Math.round(-0.4) 会得到 -0, 但 String(-0) === "0", 所以帧里
     * 不会出现 "-0" 这种畸形内容。
     *
     * @param  {number} v  原始摇杆值
     * @return {number}    -100~+100 的整数
     */
    function clampStick(v) {
        if (typeof v !== 'number' || isNaN(v)) return 0;
        if (v >  100) v =  100;
        if (v < -100) v = -100;
        return Math.round(v) | 0;
    }

    /**
     * frameMove —— 生成主控制帧
     *
     * @param  {number} throttle  油门 -100~+100, 正=前进
     * @param  {number} steer     转向 -100~+100, 正=右转
     * @return {string}           形如 "R50,-30\n"
     */
    function frameMove(throttle, steer) {
        return 'R' + clampStick(throttle) + ',' + clampStick(steer) + '\n';
    }

    /**
     * frameHold —— 生成直线保持开关帧
     * @param {boolean} on
     * @return {string}
     */
    function frameHold(on) {
        return on ? FRAME_HOLD_ON : FRAME_HOLD_OFF;
    }

    /* ====================================================================== */
    /*  混控预览 (纯显示用, 不参与控制)                                        */
    /*                                                                        */
    /*  ★ 这一段必须和 Remote.c 里的 Remote_Remap() + Remote_Run() 步骤③     */
    /*    逐位一致, 否则屏幕上显示的左右轮 PWM 就是假的。                       */
    /* ====================================================================== */

    /**
     * remap —— 摇杆值 → 占空比, 带死区抑制与死区补偿
     *
     * 对应 Remote.c 的 Remote_Remap():
     *   |v| < DEADZONE          → 0
     *   否则  MIN_DUTY + |v| * (100 - MIN_DUTY) / 100, 保留原符号
     *
     * @param  {number} v  摇杆值 -100~+100
     * @return {number}    占空比 -100~+100
     */
    function remap(v) {
        if (v > -SPEC.STICK_DEADZONE && v < SPEC.STICK_DEADZONE) return 0;

        var a = (v > 0) ? v : -v;
        a = SPEC.MIN_DUTY + a * (100 - SPEC.MIN_DUTY) / 100;

        return (v > 0) ? a : -a;
    }

    /**
     * mix —— 差速混控 + 等比限幅
     *
     * 对应 Remote.c 的 Remote_Run() 步骤③:
     *   t = remap(throttle)
     *   s = remap(steer) * (TURN_MAX / 100)
     *   left = t + s, right = t - s
     *   peak > 100 时按比例缩小两边 (不用硬截断)
     *
     * ★ 这里**不含**直线保持的修正量 —— 那要看真实陀螺仪, APP 拿不到。
     *   所以开着 Hold 时预览和实际会有差别, UI 上要标明是"预览"。
     *
     * @param  {number} throttle  油门 -100~+100
     * @param  {number} steer     转向 -100~+100
     * @return {{left:number, right:number}}
     */
    function mix(throttle, steer) {
        var t = remap(throttle);
        var s = remap(steer) * (SPEC.TURN_MAX / 100);

        var left  = t + s;
        var right = t - s;

        var peak = Math.max(Math.abs(left), Math.abs(right));
        if (peak > 100) {
            left  = left  * 100 / peak;
            right = right * 100 / peak;
        }

        return { left: left, right: right };
    }

    /* ====================================================================== */
    return {
        SPEC: SPEC,
        FRAME_ESTOP: FRAME_ESTOP,
        FRAME_RELEASE: FRAME_RELEASE,

        clampStick: clampStick,
        frameMove: frameMove,
        frameHold: frameHold,
        remap: remap,
        mix: mix
    };
})();

/* Node 环境下也能 require 出来跑对拍脚本 */
if (typeof module !== 'undefined' && module.exports) {
    module.exports = Protocol;
}
