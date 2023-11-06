import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GTop from 'gi://GTop';
import NM from 'gi://NM';
import Shell from 'gi://Shell';
import St from 'gi://St';

let systemStatsPlus;

const NetworkManager = NM;

const INDICATOR_UPDATE_INTERVAL = 250;
const INDICATOR_NUM_GRID_LINES = 3;

const ITEM_LABEL_SHOW_TIME = 0.15;
const ITEM_LABEL_HIDE_TIME = 0.1;
const ITEM_HOVER_TIMEOUT = 300;

function appLog(message, ...additionalParams) {
    console.log(`[EXTENSION SystemStatsPlus] ${message}`, ...additionalParams);
}

function mergeOptions(obj1, obj2) {
    return {...obj1, ...obj2};
}

// Number.prototype.formatMetricPretty = function (units) {
//     let value = this;
//     let metricPrefix = '';

//     if (value > 1024 * 1024) {
//         value /= 1024 * 1024;
//         metricPrefix = 'Mi';
//     } else if (value > 1024) {
//         value /= 1024;
//         metricPrefix = 'Ki';
//     }

//     return '%0.2f %s%s'.format(value, metricPrefix, units || '');
// };
function formatMetricPretty(value, units) {
    // let value = this;
    let metricPrefix = '';

    if (value > 1024 * 1024) {
        value /= 1024 * 1024;
        metricPrefix = 'Mi';
    } else if (value > 1024) {
        value /= 1024;
        metricPrefix = 'Ki';
    }

    return '%0.2f %s%s'.format(value, metricPrefix, units || '');
}

/**
 * Class representing a graph overlay for displaying stats.
 */
const GraphOverlay = class StatsPlusGraphOverlay {
    /**
     * Create a GraphOverlay.
     *
     * @param {object} options - The options for the graph overlay.
     */
    constructor(options) {
        this.label = undefined;
        this.actor = null;
        this._init(options);
    }

    _init() {
        this.label = new St.Label({style_class: 'label'});

        this.actor = new St.Bin({
            style_class: 'ssp-graph-overlay',
            reactive: true,
        });

        this.actor.add_actor(this.label);
        Main.layoutManager.addChrome(this.actor);
        this.actor.hide();
    }

    destroy() {
        this.actor.destroy();
    }
};

/**
 * Class representing a horizontal graph for displaying statistics.
 */
const HorizontalGraph = class StatsPlusHorizontalGraph {
    /**
     * Create a HorizontalGraph.
     *
     * @param {object} options - The options for the horizontal graph.
     */
    constructor(options) {
        this.graph = undefined;
        this.renderStats = [];
        this.stats = {};
        this.max = -1;
        this.options = {
            updateInterval: INDICATOR_UPDATE_INTERVAL,
            offsetX: 2,
            offsetY: -1,
            units: '',
            gridColor: 'grid-color',
            autoscale: true,
            showMax: true,
            max: 0,
        };

        this._init(options);

        if (!this.options.autoscale) {
            this.max = this.options.max;
            this._updateMaxLabel();
        }
    }

    _init(options) {
        this.options = mergeOptions(this.options, options || {});
        this.ready = true;
        this.gridColor = '#575757';
        this.styleChanged = false;

        this.graph = new St.DrawingArea({reactive: true});
        this.graph.connect('repaint', this._draw.bind(this));

        this.actor = new St.Bin({
            style_class: 'ssp-graph-area',
            reactive: true,
        });
        this.actor.add_actor(this.graph);
        this.actor.connect('style-changed', this._updateStyles.bind(this));

        this.graphoverlay = new GraphOverlay();

        this._timeout = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT,
            this.options.updateInterval,
            () => {
                if (this.graph.visible) this.graph.queue_repaint();

                return true;
            }
        );
    }

    enable() {
        this.ready = true;
    }

    disable() {
        this.ready = false;
    }

    destroy() {
        this.ready = false;
        GLib.source_remove(this._timeout);
        this.actor.destroy();
    }

    addDataSet(name, color) {
        this.renderStats.push(name);
        this.stats[name] = {
            color,
            cairo_color: -1,
            values: [],
            scaled: [],
            max: -1,
        };
    }

    addDataPoint(name, value) {
        this.stats[name].values.push(value);
    }

    // Calculate maximum value within set of values.
    _updateDataSetMax(name) {
        this.stats[name].max = this.stats[name].values.reduce((prev, cur) => {
            return Math.max(prev, cur);
        }, 0);

        if (this.max < this.stats[name].max) {
            this.max = this.stats[name].max;
            this._updateMaxLabel();
        }
    }

    _updateMax() {
        let max = 0;
        this.renderStats.forEach(k => {
            max = this.stats[k].max;
        });

        if (max < this.max) {
            this.max = max;
            this._updateMaxLabel();
        }
    }

    _updateMaxLabel() {
        if (this.options.showMax) {
            this.graphoverlay.label.set_text(
                formatMetricPretty(this.max, this.options.units)
            );
        }
    }

    _updateStyles() {
        if (this.actor.is_mapped() === false) return;

        // get and cache the grid color
        let themeNode = this.actor.get_theme_node();
        let [hasGridColor, gridColor] = themeNode.lookup_color(
            this.options.gridColor,
            false
        );
        if (hasGridColor) this.gridColor = gridColor;

        // this.renderStats.map(Lang.bind(this, function(k){
        this.renderStats.forEach(k => {
            let stat = this.stats[k];

            let [hasStatColor, statColor] = themeNode.lookup_color(
                stat.color,
                false
            );

            if (hasStatColor) {
                stat.cairo_color = statColor;
            } else {
                stat.cairo_color = new Clutter.Color({
                    red: 0,
                    green: 190,
                    blue: 240,
                    alpha: 255,
                });
            }
        });
    }

    // Used to draws major/minor division lines within the graph.
    _drawGridLines(cr, width, gridOffset, count, color) {
        for (let i = 1; i <= count; ++i) {
            cr.moveTo(0, i * gridOffset + 0.5);
            cr.lineTo(width, i * gridOffset + 0.5);
        }
        Clutter.cairo_set_source_color(cr, color);
        cr.setLineWidth(1);
        cr.setDash([2, 1], 0);
        cr.stroke();
    }

    _draw(area) {
        // Early return conditions
        if (!this._canDraw()) return;

        let [width, height] = area.get_surface_size();
        this._initializeDrawingStyles();

        let cr = area.get_context();
        if (!cr) return;

        // Draw the background grid
        // let color = new Clutter.Color(this.gridColor);
        let gridOffset = Math.floor(height / (INDICATOR_NUM_GRID_LINES + 1));

        this._drawGrid(cr, width, height, gridOffset);

        // Prepare stats for drawing
        this._prepareStatsForDrawing(width);

        // Render stats
        this._renderStats(cr, height);
    }

    _canDraw() {
        return !(
            Main.layoutManager._inOverview ||
            this.ready === false ||
            Main.overview.visibleTarget ||
            !this.actor.get_stage() ||
            !this.actor.visible
        );
    }

    _initializeDrawingStyles() {
        if (!this.styleChanged) {
            this._updateStyles();
            this.styleChanged = true;
        }
    }

    _drawGrid(cr, width, height, gridOffset) {
        let color = new Clutter.Color(this.gridColor);

        // draws major divisions
        this._drawGridLines(
            cr,
            width,
            gridOffset,
            INDICATOR_NUM_GRID_LINES,
            color
        );

        // draws minor divisions
        color.alpha *= 0.2;
        this._drawGridLines(
            cr,
            width,
            gridOffset / 2,
            INDICATOR_NUM_GRID_LINES * 2 + 1,
            color
        );
    }

    _prepareStatsForDrawing(width) {
        let renderStats = this.renderStats;

        renderStats.forEach(statKey => {
            let stat = this.stats[statKey];
            let newWidth = width + 1;

            // truncate data point values to width of graph
            stat.values = this._truncateDataPoints(stat.values, newWidth);

            if (this.options.autoscale) this._updateDataSetMax(statKey);
        });

        if (this.options.autoscale) this._updateMax();

        // Scale all data points over max
        renderStats.forEach(statKey => {
            let stat = this.stats[statKey];
            stat.scaled = this._scaleDataPoints(stat.values);
        });
    }

    _truncateDataPoints(values, newWidth) {
        if (values.length > newWidth)
            return values.slice(values.length - newWidth);

        return values;
    }

    _scaleDataPoints(values) {
        return values.map(value => value / this.max);
    }

    _renderStats(cr, height) {
        for (let i = 0; i < this.renderStats.length; ++i) {
            let stat = this.stats[this.renderStats[i]];

            if (this.max <= 0.00001) continue;

            this._renderStatDataSet(cr, height, stat, i);
        }
    }

    _renderStatDataSet(cr, height, stat, index) {
        let outlineColor = new Clutter.Color(stat.cairo_color);
        if (index === 0)
            this._renderFirstDataSet(cr, height, stat, outlineColor);

        // Render the data points
        this._plotDataSet(cr, height, stat.scaled);
        Clutter.cairo_set_source_color(cr, outlineColor);
        cr.setLineWidth(1.0);
        cr.setDash([], 0);
        cr.stroke();
    }

    _renderFirstDataSet(cr, height, stat, outlineColor) {
        outlineColor.alpha *= 0.2;

        // Render the first dataset's fill
        this._plotDataSet(cr, height, stat.scaled);
        cr.lineTo(stat.scaled.length - 1, height);
        cr.lineTo(0, height);
        cr.closePath();
        Clutter.cairo_set_source_color(cr, outlineColor);
        cr.fill();
    }

    _plotDataSet(cr, height, values) {
        cr.moveTo(0, (1 - (values[0] || 0)) * height);
        for (let k = 1; k < values.length; ++k)
            cr.lineTo(k, (1 - values[k]) * height);
    }

    setOverlayPosition(x, y) {
        this.graphoverlay.actor.set_position(
            x + this.options.offsetX,
            y + this.options.offsetY
        );
    }

    show() {
        this.ready = true;
        this.graphoverlay.actor.show();
        this.graphoverlay.actor.opacity = 0;

        this.graphoverlay.actor.ease({
            opacity: 255,
            time: ITEM_LABEL_SHOW_TIME,
            transition: Clutter.AnimationMode.EASE_OUT_QUAD,
        });
    }

    hide() {
        this.ready = false;
        this.graphoverlay.actor.hide();
    }
};

const Indicator = class StatsPlusIndicator {
    options = {
        updateInterval: INDICATOR_UPDATE_INTERVAL,
        barPadding: 1,
        barWidth: 6,
        gridColor: 'grid-color',
    };

    constructor(options) {
        this.options = mergeOptions(this.options, options || {});

        this.ready = false;
        this._timeout = 0;
        this.stats = {};
        this.renderStats = [];
        this.gridColor = '#575757';
        this.styleCached = false;

        let scaleFactor = St.ThemeContext.get_for_stage(
            global.stage
        ).scale_factor;
        this.scaleFactor = scaleFactor;

        this._barPadding = this.options.barPadding * scaleFactor;
        this._barWidth = this.options.barWidth * scaleFactor;

        this._initValues();

        // create UI elements
        this.drawing_area = new St.DrawingArea({reactive: true});
        this.drawing_area.connect('repaint', this._draw.bind(this));
        this.drawing_area.connect('button-press-event', () => {
            let app = Shell.AppSystem.get_default().lookup_app(
                'gnome-system-monitor.desktop'
            );

            if (app === undefined || app === null) {
                app = Shell.AppSystem.get_default().lookup_app(
                    'gnome-system-monitor_gnome-system-monitor.desktop'
                );
            }

            app.open_new_window(-1);
            return true;
        });

        this.actor = new St.Bin({
            style_class: 'ssp-indicator',
            reactive: true,
            track_hover: true,
        });
        this.actor.add_actor(this.drawing_area);
        this.actor.connect(
            'notify::visible',
            this._onVisibilityChanged.bind(this)
        );
        this.actor.connect('style-changed', this._updateStyles.bind(this));

        this.resized = false;

        this.dropdown = new St.Widget({
            layout_manager: new Clutter.GridLayout(),
            reactive: true,
            style_class: 'ssp-dropdown',
        });
        Main.layoutManager.addChrome(this.dropdown);
        this.dropdown.hide();
    }

    addDataSet(name, color) {
        this.renderStats.push(name);
        this.stats[name] = {
            color,
            cairo_color: false,
            values: [],
        };
    }

    addDataPoint(name, value) {
        this.stats[name].values.push(value);
    }

    _onVisibilityChanged() {
        if (!this.actor.visible) this.dropdown.hide();
    }

    enable() {
        if (this._timeout === undefined || this._timeout < 1) {
            this._timeout = GLib.timeout_add(
                GLib.PRIORITY_DEFAULT,
                this.options.updateInterval,
                () => {
                    if (this.ready) {
                        this._updateValues();
                        this.drawing_area.queue_repaint();
                    }
                    return true;
                }
            );
        }

        this.ready = true;
    }

    show() {
        this.enable();
    }

    disable() {
        this.ready = false;

        if (this._timeout > 0) {
            GLib.source_remove(this._timeout);
            this._timeout = 0;
        }
    }

    hide() {
        this.disable();
    }

    showPopup(graph) {
        this.dropdown.opacity = 0;
        this.dropdown.show();

        let monitorIndex = Main.layoutManager.primaryIndex;
        let monitor = Main.layoutManager.monitors[monitorIndex];

        let [stageX, stageY] = this.actor.get_transformed_position();

        let itemWidth = this.actor.allocation.x2 - this.actor.allocation.x1;
        let itemHeight = this.actor.allocation.y2 - this.actor.allocation.y1;

        let labelWidth = this.dropdown.width;
        let xOffset = Math.floor((itemWidth - labelWidth) / 2);

        let x = Math.min(
            stageX + xOffset,
            monitor.x + monitor.width - 4 - Math.max(itemWidth, labelWidth)
        );

        let node = this.dropdown.get_theme_node();
        let yOffset = node.get_length('-y-offset');

        let y = stageY + itemHeight + yOffset;

        if (this.dropdown.layout_manager.height !== undefined)
            this.dropdown.set_height(this.dropdown.layout_manager.height);

        this.dropdown.set_position(x, y);

        this.dropdown.ease({
            opacity: 255,
            time: ITEM_LABEL_SHOW_TIME,
            transition: Clutter.AnimationMode.EASE_OUT_QUAD,
            onComplete() {
                if (graph !== undefined) {
                    let [x1, y1] = graph.actor.get_position();
                    graph.setOverlayPosition(x + x1, y + y1);
                    graph.show();
                }
            },
        });
    }

    hidePopup(graph) {
        this.dropdown.ease({
            opacity: 0,
            time: ITEM_LABEL_HIDE_TIME,
            transition: Clutter.AnimationMode.EASE_OUT_QUAD,
            onComplete: function () {
                graph.hide();
                this.dropdown.hide();
            }.bind(this),
        });
    }

    destroy() {
        this.ready = false;

        if (this._timeout > 0) GLib.source_remove(this._timeout);

        this.actor.destroy();
    }

    _createPanel() {
        appLog('_createPanel::');
    }

    _destroyPanel() {
        appLog('_destroyPanel::');
    }

    onShowPanel() {
        this.show();
    }

    onHidePanel() {
        this.hide();
    }

    _initValues() {
        appLog('_initValues::');
    }

    _updateValues() {
        appLog('_updateValues::');
    }

    _updateStyles() {
        if (this.actor.is_mapped() === false) return;

        let [width, height] = this.drawing_area.get_size();

        this.drawing_area.set_width(width * this.scaleFactor);
        this.drawing_area.set_height(height * this.scaleFactor);

        // get and cache the grid color
        let themeNode = this.actor.get_theme_node();
        let [hasGridColor, gridColor] = themeNode.lookup_color(
            this.options.gridColor,
            false
        );
        if (hasGridColor) this.gridColor = gridColor;

        this.renderStats.forEach(k => {
            let stat = this.stats[k];

            let [hasStatColor, statColor] = themeNode.lookup_color(
                stat.color,
                false
            );

            if (hasStatColor) {
                stat.cairo_color = statColor;
            } else {
                stat.cairo_color = new Clutter.Color({
                    red: 0,
                    green: 190,
                    blue: 240,
                    alpha: 255,
                });
            }
        });
    }

    _draw(area) {
        if (!this.ready) return;
        if (Main.overview.visibleTarget) return;
        if (!this.actor.get_stage()) return;
        if (!this.actor.visible) return;

        let [width, height] = area.get_surface_size();
        let cr = area.get_context();
        if (!cr) return;

        if (!this.styleCached) {
            this._updateStyles();
            this.styleCached = true;
        }

        // resize container based on number of bars to chart
        if (this.resized === undefined || !this.resized) {
            this.actor.set_width(
                this.renderStats.length * (this._barWidth + this._barPadding) +
                    this._barPadding * 2.0 -
                    1
            );
            this.resized = true;
        }

        // draw the background grid
        let gridColor = new Clutter.Color(this.gridColor);
        let gridOffset = Math.floor(height / (INDICATOR_NUM_GRID_LINES + 2));
        for (let i = 0; i <= INDICATOR_NUM_GRID_LINES + 2; ++i) {
            cr.moveTo(0, i * gridOffset);
            cr.lineTo(width, i * gridOffset);
        }
        Clutter.cairo_set_source_color(cr, gridColor);
        cr.setLineWidth(1);
        cr.setDash([2, 1], 0);
        cr.stroke();

        let renderStats = this.renderStats;

        // Make sure we don't have more sample points than pixels
        renderStats.forEach(k => {
            let stat = this.stats[k];
            let keepNumStats = 3;

            if (stat.values.length > keepNumStats) {
                stat.values = stat.values.slice(
                    stat.values.length - keepNumStats,
                    stat.values.length
                );
            }
        });

        for (let i = 0; i < renderStats.length; ++i) {
            let stat = this.stats[renderStats[i]];
            // We outline at full opacity and fill with 40% opacity
            let outlineColor = stat.cairo_color;
            let color = new Clutter.Color(outlineColor);
            color.alpha *= 0.8;

            // Render the bar graph's fill
            this._plotDataSet(cr, height, i, stat.values, false);
            cr.lineTo((i + 1) * (this._barWidth + this._barPadding), height);
            cr.lineTo(
                i * (this._barWidth + this._barPadding) + this._barPadding,
                height
            );
            cr.closePath();
            Clutter.cairo_set_source_color(cr, color);
            cr.fill();

            // Render the bar graph's height line
            this._plotDataSet(cr, height, i, stat.values, false, 0.5);
            Clutter.cairo_set_source_color(cr, outlineColor);
            cr.setLineWidth(1.0);
            cr.setDash([], 0);
            cr.stroke();
        }
    }

    _plotDataSet(cr, height, position, values, reverse, nudge = 0) {
        let barOuterWidth = this._barWidth + this._barPadding;
        let barHeight = 1 - (values[0] || 0);

        cr.moveTo(
            position * barOuterWidth + this._barPadding,
            barHeight * height + nudge
        );
        cr.lineTo((position + 1) * barOuterWidth, barHeight * height + nudge);
    }
};

const CpuIndicator = class StatsPlusCpuIndicator extends Indicator {
    constructor() {
        super({
            updateInterval: 250,
            decay: 0.2,
        });

        this.current_label = new St.Label({style_class: 'title_label'});
        this.current_label.set_text('Current:');

        this.current_cpu_label = new St.Label({
            style_class: 'description_label',
        });
        this.current_cpu_label.set_text('Total CPU usage');
        this.current_cpu_value = new St.Label({style_class: 'value_label'});

        let layout = this.dropdown.layout_manager;

        this.cpu_graph = new HorizontalGraph({
            autoscale: false,
            max: 100,
            units: '%',
            showMax: false,
        });
        this.cpu_graph.addDataSet('cpu-usage', 'cpu-color');

        layout.attach(this.cpu_graph.actor, 0, 0, 2, 1);

        let x = 0,
            y = 1;
        layout.attach(this.current_label, x + 0, y + 0, 2, 1);
        layout.attach(this.current_cpu_label, x + 0, y + 1, 1, 1);
        layout.attach(this.current_cpu_value, x + 1, y + 1, 1, 1);
    }

    _initValues() {
        this._prev = new GTop.glibtop_cpu();
        GTop.glibtop_get_cpu(this._prev);

        // get number of cores
        this.ncpu = 1;

        try {
            this.ncpu = GTop.glibtop_get_sysinfo().ncpu;
        } catch (e) {
            global.logError(e);
        }

        this._pcpu = [];

        // populate statistics variables
        for (let cpu = 0; cpu < this.ncpu; cpu++) {
            let key = `cpu_${cpu}`;

            this.addDataSet(key, 'cpu-color');
            this._pcpu[cpu] = 0;
        }

        this.enable();
    }

    _updateValues() {
        // Query current iteration CPU statistics
        let cpu = new GTop.glibtop_cpu();
        let cpuTtlUsage = 0;

        GTop.glibtop_get_cpu(cpu);

        // Collect per-CPU statistics
        for (let i = 0; i < this.ncpu; ++i) {
            let total = Math.max(
                cpu.xcpu_total[i] - this._prev.xcpu_total[i],
                0
            );
            let idle = Math.max(cpu.xcpu_idle[i] - this._prev.xcpu_idle[i], 0);
            let key = `cpu_${i}`;

            let reading = 0;
            if (total > 0) reading = 1.0 - idle / total;

            cpuTtlUsage += reading;

            let decayedValue = Math.min(
                this._pcpu[i] * this.options.decay,
                0.999999999
            );
            let value = Math.max(reading, decayedValue);

            this.addDataPoint(key, value);

            this._pcpu[i] = value;
        }

        cpuTtlUsage /= this.ncpu;
        cpuTtlUsage *= 100;
        this.cpu_graph.addDataPoint('cpu-usage', cpuTtlUsage);

        let cpuTtlText = '%s%%'.format(formatMetricPretty(cpuTtlUsage, ''));
        this.current_cpu_value.set_text(cpuTtlText);

        // Store this iteration for next calculation run
        this._prev = cpu;
    }

    enable() {
        super.enable();
        if (this.cpu_graph) this.cpu_graph.enable();
    }

    disable() {
        if (this.cpu_graph) this.cpu_graph.disable();
        super.disable();
    }

    showPopup() {
        this.cpu_graph.enable();
        super.showPopup(this.cpu_graph);
    }

    hidePopup() {
        this.cpu_graph.disable();
        super.hidePopup(this.cpu_graph);
    }
};

const MemoryIndicator = class StatsPlusMemoryIndicator extends Indicator {
    constructor() {
        super({
            updateInterval: 1000,
        });

        this.current_label = new St.Label({style_class: 'title_label'});
        this.current_label.set_text('Current:');

        // used, buffer, shared, cached, slab, locked, free, total
        this.current_mem_used_label = new St.Label({
            style_class: 'description_label',
        });
        this.current_mem_used_label.set_text('Total memory usage');
        this.current_mem_used_value = new St.Label({
            style_class: 'value_label',
        });

        this.current_mem_buffer_label = new St.Label({
            style_class: 'description_label',
        });
        this.current_mem_buffer_label.set_text('Total buffer usage');
        this.current_mem_buffer_value = new St.Label({
            style_class: 'value_label',
        });

        this.current_mem_shared_label = new St.Label({
            style_class: 'description_label',
        });
        this.current_mem_shared_label.set_text('Total shared usage');
        this.current_mem_shared_value = new St.Label({
            style_class: 'value_label',
        });

        this.current_mem_cached_label = new St.Label({
            style_class: 'description_label',
        });
        this.current_mem_cached_label.set_text('Total cache usage');
        this.current_mem_cached_value = new St.Label({
            style_class: 'value_label',
        });

        this.current_mem_slab_label = new St.Label({
            style_class: 'description_label',
        });
        this.current_mem_slab_label.set_text('Total slab usage');
        this.current_mem_slab_value = new St.Label({
            style_class: 'value_label',
        });

        this.current_mem_locked_label = new St.Label({
            style_class: 'description_label',
        });
        this.current_mem_locked_label.set_text('Total locked usage');
        this.current_mem_locked_value = new St.Label({
            style_class: 'value_label',
        });

        this.current_mem_free_label = new St.Label({
            style_class: 'description_label',
        });
        this.current_mem_free_label.set_text('Total free usage');
        this.current_mem_free_value = new St.Label({
            style_class: 'value_label',
        });

        this.current_mem_total_label = new St.Label({
            style_class: 'description_label',
        });
        this.current_mem_total_label.set_text('Total RAM present');
        this.current_mem_total_value = new St.Label({
            style_class: 'value_label',
        });

        let layout = this.dropdown.layout_manager;

        GTop.glibtop_get_mem(this.mem);

        this.mem_graph = new HorizontalGraph({
            autoscale: false,
            units: 'B',
            max: this.mem.total,
        });
        this.mem_graph.addDataSet('mem-used', 'mem-used-color');

        layout.attach(this.mem_graph.actor, 0, 0, 2, 1);

        let x = 0,
            y = 1;
        layout.attach(this.current_label, x + 0, y + 0, 2, 1);
        // used, buffer, shared, cached, slab, locked, free, total
        layout.attach(this.current_mem_used_label, x + 0, y + 1, 1, 1);
        layout.attach(this.current_mem_used_value, x + 1, y + 1, 1, 1);
        layout.attach(this.current_mem_buffer_label, x + 0, y + 2, 1, 1);
        layout.attach(this.current_mem_buffer_value, x + 1, y + 2, 1, 1);
        layout.attach(this.current_mem_shared_label, x + 0, y + 3, 1, 1);
        layout.attach(this.current_mem_shared_value, x + 1, y + 3, 1, 1);
        layout.attach(this.current_mem_cached_label, x + 0, y + 4, 1, 1);
        layout.attach(this.current_mem_cached_value, x + 1, y + 4, 1, 1);
        y += 5;
        if (this.mem.slab !== undefined) {
            layout.attach(this.current_mem_slab_label, x + 0, y, 1, 1);
            layout.attach(this.current_mem_slab_value, x + 1, y, 1, 1);
            ++y;
        }
        layout.attach(this.current_mem_locked_label, x + 0, y, 1, 1);
        layout.attach(this.current_mem_locked_value, x + 1, y, 1, 1);
        ++y;
        layout.attach(this.current_mem_free_label, x + 0, y, 1, 1);
        layout.attach(this.current_mem_free_value, x + 1, y, 1, 1);
        ++y;
        layout.attach(this.current_mem_total_label, x + 0, y, 1, 1);
        layout.attach(this.current_mem_total_value, x + 1, y, 1, 1);
        ++y;
    }

    _initValues() {
        this.mem = new GTop.glibtop_mem();

        this.addDataSet('mem-used', 'mem-used-color');
        this.enable();
    }

    _updateValues() {
        GTop.glibtop_get_mem(this.mem);

        let memUsed = this.mem.user;
        if (this.mem.slab !== undefined) memUsed -= this.mem.slab;
        let t = memUsed / this.mem.total;
        this.addDataPoint('mem-used', t);

        this.mem_graph.addDataPoint('mem-used', memUsed);

        let memTtlText = '%s'.format(formatMetricPretty(memUsed, 'B'));
        this.current_mem_used_value.set_text(memTtlText);

        memTtlText = '%s'.format(formatMetricPretty(this.mem.buffer, 'B'));
        this.current_mem_buffer_value.set_text(memTtlText);

        memTtlText = '%s'.format(formatMetricPretty(this.mem.shared, 'B'));
        this.current_mem_shared_value.set_text(memTtlText);

        memTtlText = '%s'.format(formatMetricPretty(this.mem.cached, 'B'));
        this.current_mem_cached_value.set_text(memTtlText);

        if (this.mem.slab !== undefined) {
            memTtlText = '%s'.format(formatMetricPretty(this.mem.slab, 'B'));
            this.current_mem_slab_value.set_text(memTtlText);
        }

        memTtlText = '%s'.format(formatMetricPretty(this.mem.locked, 'B'));
        this.current_mem_locked_value.set_text(memTtlText);

        memTtlText = '%s'.format(formatMetricPretty(this.mem.free, 'B'));
        this.current_mem_free_value.set_text(memTtlText);

        memTtlText = '%s'.format(formatMetricPretty(this.mem.total, 'B'));
        this.current_mem_total_value.set_text(memTtlText);
    }

    enable() {
        super.enable();
        if (this.mem_graph) this.mem_graph.enable();
    }

    disable() {
        if (this.mem_graph) this.mem_graph.disable();
        super.disable();
    }

    showPopup() {
        this.mem_graph.enable();
        super.showPopup(this.mem_graph);
    }

    hidePopup() {
        this.mem_graph.disable();
        super.hidePopup(this.mem_graph);
    }
};

const SwapIndicator = class StatsPlusSwapIndicator extends Indicator {
    constructor() {
        super({
            updateInterval: 2000,
        });

        this.current_label = new St.Label({style_class: 'title_label'});
        this.current_label.set_text('Current:');

        this.current_swap_label = new St.Label({
            style_class: 'description_label',
        });
        this.current_swap_label.set_text('Total swap usage');
        this.current_swap_value = new St.Label({style_class: 'value_label'});

        let layout = this.dropdown.layout_manager;

        GTop.glibtop_get_swap(this.swap);

        this.swap_graph = new HorizontalGraph({
            autoscale: false,
            max: this.swap.total,
            units: 'B',
        });
        this.swap_graph.addDataSet('swap-used', 'swap-used-color');

        layout.attach(this.swap_graph.actor, 0, 0, 2, 1);

        let x = 0,
            y = 1;
        layout.attach(this.current_label, x + 0, y + 0, 2, 1);
        layout.attach(this.current_swap_label, x + 0, y + 1, 1, 1);
        layout.attach(this.current_swap_value, x + 1, y + 1, 1, 1);
    }

    _initValues() {
        this.swap = new GTop.glibtop_swap();

        this.addDataSet('swap-used', 'swap-used-color');
        this.enable();
    }

    _updateValues() {
        GTop.glibtop_get_swap(this.swap);

        let t = this.swap.used / this.swap.total;
        this.addDataPoint('swap-used', t);

        this.swap_graph.addDataPoint('swap-used', this.swap.used);

        let swapTtlText = '%s'.format(formatMetricPretty(this.swap.used, 'B'));
        this.current_swap_value.set_text(swapTtlText);

        if (t > 0.5) this.stats['swap-used'].color = 'swap-used-bad-color';
        else if (t > 0.25)
            this.stats['swap-used'].color = 'swap-used-warn-color';
        else this.stats['swap-used'].color = 'swap-used-color';
    }

    enable() {
        super.enable();
        if (this.swap_graph) this.swap_graph.enable();
    }

    disable() {
        if (this.swap_graph) this.swap_graph.disable();
        super.disable();
    }

    showPopup() {
        this.swap_graph.enable();
        super.showPopup(this.swap_graph);
    }

    hidePopup() {
        this.swap_graph.disable();
        super.hidePopup(this.swap_graph);
    }
};

const NetworkIndicator = class SystemStatsPlusNetworkIndicator extends Indicator {
    constructor() {
        super();

        this.current_label = new St.Label({style_class: 'title_label'});
        this.current_label.set_text('Current:');

        this.current_in_label = new St.Label({
            style_class: 'description_label',
        });
        this.current_in_label.set_text('Inbound');
        this.current_in_value = new St.Label({style_class: 'value_label'});

        this.current_out_label = new St.Label({
            style_class: 'description_label',
        });
        this.current_out_label.set_text('Outbound');
        this.current_out_value = new St.Label({style_class: 'value_label'});

        this.maximum_label = new St.Label({style_class: 'title_label'});
        this.maximum_label.set_text('Maximum (over 2 hours):');

        this.maximum_in_label = new St.Label({
            style_class: 'description_label',
        });
        this.maximum_in_label.set_text('Inbound');
        this.maximum_in_value = new St.Label({style_class: 'value_label'});

        this.maximum_out_label = new St.Label({
            style_class: 'description_label',
        });
        this.maximum_out_label.set_text('Outbound');
        this.maximum_out_value = new St.Label({style_class: 'value_label'});

        let layout = this.dropdown.layout_manager;

        this.net_graph = new HorizontalGraph({units: 'b/s'});
        this.net_graph.addDataSet('network-in-used', 'network-in-color');
        this.net_graph.addDataSet('network-out-used', 'network-out-color');

        layout.attach(this.net_graph.actor, 0, 0, 2, 1);

        let x = 0,
            y = 1;
        layout.attach(this.current_label, x + 0, y + 0, 2, 1);
        layout.attach(this.current_in_label, x + 0, y + 1, 1, 1);
        layout.attach(this.current_in_value, x + 1, y + 1, 1, 1);
        layout.attach(this.current_out_label, x + 0, y + 2, 1, 1);
        layout.attach(this.current_out_value, x + 1, y + 2, 1, 1);

        layout.attach(this.maximum_label, x + 0, y + 3, 2, 1);
        layout.attach(this.maximum_in_label, x + 0, y + 4, 1, 1);
        layout.attach(this.maximum_in_value, x + 1, y + 4, 1, 1);
        layout.attach(this.maximum_out_label, x + 0, y + 5, 1, 1);
        layout.attach(this.maximum_out_value, x + 1, y + 5, 1, 1);
    }

    enable() {
        super.enable();
        if (this.net_graph) this.net_graph.enable();
    }

    disable() {
        if (this.net_graph) this.net_graph.disable();
        super.disable();
    }

    showPopup() {
        this.net_graph.enable();
        super.showPopup(this.net_graph);
    }

    hidePopup() {
        this.net_graph.disable();
        super.hidePopup(this.net_graph);
    }

    _initValues() {
        this._ifs = [];
        this._ifs_speed = [];
        this._iface_list = [];
        this._last = [0, 0, 0, 0, 0];
        this._usage = [0, 0, 0, 0, 0];
        this._usedp = 0;
        this._previous = [-1, -1, -1, -1, -1];
        this._nmclient = NM.Client.new(null);
        this._update_iface_list();

        this._nmclient.connect(
            'device-added',
            this._update_iface_list.bind(this)
        );
        this._nmclient.connect(
            'device-removed',
            this._update_iface_list.bind(this)
        );

        this._gtop = new GTop.glibtop_netload();
        this._last_time = 0;
        this._total = 0;

        this.addDataSet('network-in-used', 'network-ok-color');
        this.addDataSet('network-out-used', 'network-ok-color');
        this.enable();
    }

    _update_iface_list() {
        if (this._iface_list !== undefined && this._ifSignalIds !== undefined) {
            for (let j = 0; j < this._ifSignalIds.length; j++)
                this._iface_list[j].disconnect(this._ifSignalIds[j]);

            this._iface_list = null;
            this._ifSignalIds = null;
        }

        try {
            this._ifs = [];
            this._ifs_speed = [];
            this._ifSignalIds = [];
            let ifaceList = this._nmclient.get_devices();
            this._iface_list = ifaceList;

            for (let j = 0; j < ifaceList.length; j++) {
                this._ifSignalIds[j] = ifaceList[j].connect(
                    'state-changed',
                    this._update_iface_list.bind(this)
                );
                if (
                    ifaceList[j].state === NetworkManager.DeviceState.ACTIVATED
                ) {
                    this._ifs.push(
                        ifaceList[j].get_ip_iface() || ifaceList[j].get_iface()
                    );
                    this._ifs_speed.push(
                        ifaceList[j].get_speed !== undefined
                            ? ifaceList[j].get_speed()
                            : -1
                    );
                    this._iface_list[j].name =
                        ifaceList[j].get_ip_iface() || ifaceList[j].get_iface();
                    this._iface_list[j].stateFace = ifaceList[j].state;
                } else {
                    this._ifs.push(null);
                    this._ifs_speed.push(null);
                }
            }

            appLog(
                'Interfaces found:',
                this._iface_list.filter(iface => iface.name !== undefined)
                    .length
            );
        } catch (e) {
            global.logError(
                `Please install Network Manager GObject Introspection Bindings:${e}`
            );
        }
    }

    /**
     * Accumulates the network values for each activated device.
     *
     * @returns {Array} accum - an array containing the accumulated network values
     */
    _accumulateDeviceValues() {
        let accum = new Array(6).fill(0);

        for (const device of this._iface_list) {
            // Verifica se a interface de rede está ativada
            if (device.state === NetworkManager.DeviceState.ACTIVATED) {
                // Obter os dados de rede para a interface atual
                GTop.glibtop_get_netload(this._gtop, device.name);

                // Acumula os dados de rede
                accum[0] += this._gtop.bytes_in; // Total de bytes recebidos
                accum[1] += this._gtop.errors_in; // Total de erros de entrada
                accum[2] += this._gtop.bytes_out; // Total de bytes enviados
                accum[3] += this._gtop.errors_out; // Total de erros de saída
                accum[4] += this._gtop.collisions; // Total de colisões
                // Suponha que exista um método para obter a velocidade da interface
                accum[5] += this._ifs_speed[device.index]; // Total da velocidade
            }
        }

        return accum;
    }

    /**
     * Convert bytes to bits by multiplying by 8 (1 byte = 8 bits).
     * This function converts the receive rate and send rate from bytes per second to bits per second.
     */
    _convertToBitsPerSecond() {
        // Convertendo bytes para bits multiplicando por 8 (1 byte = 8 bits)
        this._usage[0] *= 8; // Conversão da taxa de recebimento para bps
        this._usage[2] *= 8; // Conversão da taxa de envio para bps
    }

    /**
     * Updates the user interface based on the current traffic usage.
     *
     * @returns {void} This function does not return a value.
     */
    _updateUI() {
        let firstRun = true;
        for (let i = 0; i < 5; i++) {
            if (this._previous[i] !== -1) {
                let lambda = 0.9999;
                this._previous[i] = Math.max(
                    this._usage[i],
                    lambda * this._previous[i]
                );
                firstRun = false;
            } else {
                this._previous[i] = this._usage[i];
            }
        }

        if (firstRun) {
            this._previous[0] = 56 * 1024;
            this._previous[2] = 56 * 1024;
        } else {
            /* Store current traffic values */
            this.addDataPoint(
                'network-in-used',
                this._usage[0] / this._previous[0]
            );
            this.addDataPoint(
                'network-out-used',
                this._usage[2] / this._previous[2]
            );

            this.net_graph.addDataPoint('network-in-used', this._usage[0]);
            this.net_graph.addDataPoint('network-out-used', this._usage[2]);

            let inValue = '%sb/s'.format(
                formatMetricPretty(this._usage[0], '')
            );
            this.current_in_value.set_text(inValue);

            let outValue = '%sb/s'.format(
                formatMetricPretty(this._usage[2], '')
            );
            this.current_out_value.set_text(outValue);

            let maxInValue = '%sb/s'.format(
                formatMetricPretty(this._previous[0], '')
            );
            this.maximum_in_value.set_text(maxInValue);

            let maxOutValue = '%sb/s'.format(
                formatMetricPretty(this._previous[2], '')
            );
            this.maximum_out_value.set_text(maxOutValue);
        }
    }

    /**
     * Checks for errors in the network statistics and updates the color accordingly.
     */
    _checkForErrors() {
        if (this._previous[1] > 0 || this._previous[4] > 0)
            this.stats['network-in-used'].color = 'network-bad-color';
        else this.stats['network-in-used'].color = 'network-ok-color';

        /* Report errors for outgoing traffic */
        if (this._previous[3] > 0 || this._previous[4] > 0)
            this.stats['network-out-used'].color = 'network-bad-color';
        else this.stats['network-out-used'].color = 'network-ok-color';
    }

    /**
     * Updates the values of certain variables based on the current state.
     *
     * This function calculates the difference between the current and previous device values
     * and updates the usage array accordingly. It then converts the traffic to bits per second,
     * performs an exponential decay over a certain time interval, and updates the user interface.
     * Finally, it checks for errors in the incoming traffic and reports them if necessary.
     *
     * This function does not return anything.
     */
    _updateValues() {
        const accum = this._accumulateDeviceValues();

        let time = GLib.get_monotonic_time() * 0.000001024; // seconds
        let delta = time - this._last_time;
        if (delta > 0) {
            for (let i = 0; i < 5; i++) {
                this._usage[i] = (accum[i] - this._last[i]) / delta;
                this._last[i] = accum[i];
            }

            /* Convert traffic to bits per second */
            this._convertToBitsPerSecond();

            /* exponential decay over around 2 hours at 250 interval */
            this._updateUI();

            /* Report errors for incoming traffic */
            this._checkForErrors();
        }
        this._last_time = time;
    }
};

const INDICATORS = [
    CpuIndicator,
    MemoryIndicator,
    SwapIndicator,
    NetworkIndicator,
];

const SystemStatsPlus = class StatsPlusExtension {
    constructor() {
        this._showPopupTimeoutId = 0;
        this._resetHoverTimeoutId = 0;
        this._popupShowing = false;

        this._createIndicators();
    }

    _createIndicators() {
        this._box = new St.BoxLayout({
            style_class: 'ssp-container',
            x_align: Clutter.ActorAlign.START,
            x_expand: true,
        });
        this._indicators = [];

        for (const IndicatorClass of INDICATORS) {
            let indicator = new IndicatorClass();

            indicator.actor.connect('notify::hover', () => {
                this._onHover(indicator);
            });
            this._box.add_actor(indicator.actor);
            this._indicators.push(indicator);
        }

        this._boxHolder = new St.BoxLayout({
            x_expand: true,
            y_expand: true,
            x_align: Clutter.ActorAlign.START,
        });
        this._boxHolder.add_child(this._box);
    }

    get showInLockScreen() {
        return false;
    }

    get detailsInLockScreen() {
        return false;
    }

    enable() {
        this._indicators.forEach(indicator => {
            appLog('indicator::enable', indicator.constructor.name);
            indicator.enable();
        });

        Main.panel._rightBox.insert_child_at_index(this._boxHolder, 0);
    }

    show() {
        this.enable();
    }

    disable() {
        this._indicators.forEach(i => {
            i.disable();
        });

        Main.panel._rightBox.remove_child(this._boxHolder);
    }

    hide() {
        this.disable();
    }

    destroy() {
        this._indicators.forEach(i => {
            i.destroy();
        });

        Main.panel._rightBox.remove_child(this._boxHolder);

        this._boxHolder.remove_child(this._box);

        if (this._showPopupTimeoutId > 0) {
            GLib.source_remove(this._showPopupTimeoutId);
            this._showPopupTimeoutId = 0;
        }

        this._box.destroy();
        this._boxHolder.destroy();
    }

    _onHover(item) {
        if (item.actor.get_hover()) {
            if (this._showPopupTimeoutId === 0) {
                let timeout = this._popupShowing ? 0 : ITEM_HOVER_TIMEOUT;
                this._showPopupTimeoutId = GLib.timeout_add(
                    GLib.PRIORITY_DEFAULT,
                    timeout,
                    () => {
                        this._popupShowing = true;
                        item.showPopup();
                        this._showPopupTimeoutId = 0;
                        return false;
                    }
                );
                if (this._resetHoverTimeoutId > 0) {
                    GLib.source_remove(this._resetHoverTimeoutId);
                    this._resetHoverTimeoutId = 0;
                }
            }
        } else {
            if (this._showPopupTimeoutId > 0)
                GLib.source_remove(this._showPopupTimeoutId);
            this._showPopupTimeoutId = 0;
            item.hidePopup();
            if (this._popupShowing) {
                this._resetHoverTimeoutId = GLib.timeout_add(
                    GLib.PRIORITY_DEFAULT,
                    ITEM_HOVER_TIMEOUT,
                    () => {
                        this._popupShowing = false;
                        this._resetHoverTimeoutId = 0;
                        return false;
                    }
                );
            }
        }
    }
};

export default class SystemStatsPlusExtension extends Extension {
    enable() {
        systemStatsPlus = new SystemStatsPlus(this);
        appLog('enable');
        systemStatsPlus.enable();
    }

    disable() {
        appLog('disable');
        systemStatsPlus.disable();
        systemStatsPlus.destroy();
        systemStatsPlus = null;
    }
}
