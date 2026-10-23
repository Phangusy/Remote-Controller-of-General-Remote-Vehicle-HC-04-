/**
 * joystick.js —— 单轴虚拟摇杆组件
 *
 * 为什么是"单轴":
 *   用户要的是"一个管前后的摇杆 + 一个管左右的摇杆"。所以左杆只取垂直
 *   分量、右杆只取水平分量。手指斜着拖也不会误触发另一个轴, 视觉上把手
 *   也只在那一条线上滑动 —— 一眼就看得出这是单轴杆。
 *
 * 为什么用 Pointer Events 而不是 Touch Events:
 *   一套代码同时支持触屏和鼠标; 而且不同的 pointerId 天然独立,
 *   两个手指同时操作两个摇杆时不会互相抢事件。
 *
 * 用法:
 *   var js = new Joystick(element, 'y', function (value) { ... });
 *   value 范围 -100 ~ +100
 *     'y' 轴: 向上推 = 正 (前进), 向下拉 = 负 (后退)
 *     'x' 轴: 向右推 = 正 (右转), 向左拉 = 负 (左转)
 */

function Joystick(el, axis, onChange) {
    var self = this;

    this.el      = el;
    this.axis    = (axis === 'x') ? 'x' : 'y';
    this.onChange = onChange || function () {};
    this.value   = 0;

    this.knob    = el.querySelector('.jk-knob');
    this.activeId = null;       /* 当前捕获的 pointerId, null = 未按下 */
    this.center  = { x: 0, y: 0 };
    this.radius  = 1;

    /* ====================================================================== */
    /*  几何测量 —— 按下时才算, 避免旋转屏幕 / 布局变化后用到旧值                */
    /* ====================================================================== */
    function measure() {
        var baseRect = el.getBoundingClientRect();
        var knobRect = self.knob.getBoundingClientRect();

        self.center.x = baseRect.left + baseRect.width  / 2;
        self.center.y = baseRect.top  + baseRect.height / 2;

        /* ★ 行程按轴取: 垂直杆看高度, 水平杆看宽度.
         *
         *   原来一律用 width 算, 对圆形摇杆没影响 (宽高相等),
         *   但垂直长条摇杆的宽度只有 100 来像素, 会算出一个极小的半径 ——
         *   行程短得没法用, 100 个等级挤在几十像素里, 根本谈不上线性度.
         *   按轴取之后, 垂直杆的行程由它的高度决定, 可以拉满整屏. */
        if (self.axis === 'y') {
            self.radius = (baseRect.height - knobRect.height) / 2 - 2;
        } else {
            self.radius = (baseRect.width - knobRect.width) / 2 - 2;
        }

        if (self.radius < 1) self.radius = 1;
    }

    /* ====================================================================== */
    /*  把手位置                                                               */
    /* ====================================================================== */
    function setKnob(dx, dy) {
        self.knob.style.transform =
            'translate(-50%, -50%) translate(' + dx + 'px, ' + dy + 'px)';
    }

    /* ====================================================================== */
    /*  由指针坐标算出轴向值                                                    */
    /* ====================================================================== */
    function updateFromPointer(px, py) {
        var dx = px - self.center.x;
        var dy = py - self.center.y;

        if (self.axis === 'y') {
            /* 只取垂直分量; 向上 (dy < 0) 是前进 → 取反 */
            dx = 0;
            if (dy >  self.radius) dy =  self.radius;
            if (dy < -self.radius) dy = -self.radius;
            self.value = -(dy / self.radius) * 100;
        } else {
            /* 只取水平分量; 向右 (dx > 0) 是右转 → 保持正号 */
            dy = 0;
            if (dx >  self.radius) dx =  self.radius;
            if (dx < -self.radius) dx = -self.radius;
            self.value = (dx / self.radius) * 100;
        }

        setKnob(dx, dy);
        self.onChange(self.value);
    }

    /* ====================================================================== */
    /*  事件                                                                   */
    /* ====================================================================== */
    function onDown(e) {
        if (self.activeId !== null) return;   /* 已有手指在操作, 忽略第二根 */
        self.activeId = e.pointerId;

        /* 捕获指针: 手指滑出底座也不丢事件 */
        try { el.setPointerCapture(e.pointerId); } catch (err) {}

        el.classList.add('jk-active');
        measure();
        updateFromPointer(e.clientX, e.clientY);
        e.preventDefault();
    }

    function onMove(e) {
        if (e.pointerId !== self.activeId) return;
        updateFromPointer(e.clientX, e.clientY);
        e.preventDefault();
    }

    function onUp(e) {
        if (e.pointerId !== self.activeId) return;
        self.activeId = null;
        el.classList.remove('jk-active');

        /* 松手回中 */
        self.value = 0;
        setKnob(0, 0);
        self.onChange(0);
        e.preventDefault();
    }

    el.addEventListener('pointerdown',   onDown);
    el.addEventListener('pointermove',   onMove);
    el.addEventListener('pointerup',     onUp);
    el.addEventListener('pointercancel', onUp);
    el.addEventListener('contextmenu', function (e) { e.preventDefault(); });

    /* ====================================================================== */
    /*  对外接口                                                               */
    /* ====================================================================== */
    this.reset = function () {
        /* ★ 故意**不**清 activeId.
         *   清掉的话, 如果用户手指还按在摇杆上 (比如点了急停又继续推),
         *   后续的 pointermove / pointerup 会因为 pointerId 不匹配而全被丢弃,
         *   必须抬手重压才恢复 —— 体验很怪.
         *   保留 activeId, 值归零, 用户继续拖就自然重新生效. */
        self.value = 0;
        setKnob(0, 0);
        self.onChange(0);
    };

    this.getValue = function () {
        return self.value;
    };

    /* 首帧先量一次, 让把手一开始就居中 */
    measure();
    setKnob(0, 0);
}
