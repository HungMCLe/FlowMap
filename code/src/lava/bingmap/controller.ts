import { ILocation, IBound } from './converter';
import { anchorPixel, bound, anchor, fitOptions, area } from './converter';
import { keys, IPoint, partial } from '../type';
import { ISelex, selex } from '../d3';

type Action<T> = (a: T) => void;

export interface IMapElement {
  forest: boolean,
  label: boolean,
  road: "color" | "gray" | 'gray_label' | "hidden",
  icon: boolean,
  area: boolean,
  building: boolean,
  city: boolean,
  scale: boolean
}

export interface IMapControl {
  type: 'hidden' | 'aerial' | 'road' | 'grayscale' | 'canvasDark' | 'canvasLight',
  lang: string,
  pan: boolean,
  zoom: boolean
}

export interface IMapFormat extends IMapControl, IMapElement { }

export function defaultZoom(width: number, height: number): number {
  const min = Math.min(width, height);
  for (var level = 1; level < 20; level++) {
    if (256 * Math.pow(2, level) > min) {
      break;
    }
  }
  return level;
}

// Leaflet map wrapper - pixel conversion using Web Mercator math
export function pixel(map: any, loc: ILocation, ref?: any): IPoint {
  if (!map) return { x: 0, y: 0 };
  const point = map.latLngToContainerPoint([loc.latitude, loc.longitude]);
  return { x: point.x, y: point.y };
}

export class MapFormat implements IMapFormat {
  type = 'road' as 'aerial' | 'road' | 'grayscale' | 'canvasDark' | 'canvasLight';
  lang = 'default';
  pan = true;
  zoom = true;
  city = false;
  road = "color" as "color" | "gray" | 'gray_label' | "hidden";
  label = true;
  forest = true;
  icon = false;
  building = false;
  area = false;
  scale = false;

  public static build(...fmts: any[]): MapFormat {
    var ret = new MapFormat();
    for (let f of fmts.filter(v => v)) {
      for (var key in ret) {
        if (key in f) {
          ret[key] = f[key];
        }
      }
    }
    return ret;
  }

  public static control<T>(fmt: MapFormat, extra: T): IMapControl & T {
    let result = partial(fmt, ['type', 'lang', 'pan', 'zoom']) as any;
    for (let key in extra) {
      result[key] = extra[key];
    }
    return result;
  }

  public static element<T>(fmt: MapFormat, extra: T): IMapElement & T {
    let result = partial(fmt, ['road', 'forest', 'label', 'city', 'icon', 'building', 'area', 'scale']) as any;
    for (let key in extra) {
      result[key] = extra[key];
    }
    return result;
  }
}

export function coordinate(map: any, pxl: IPoint): ILocation {
  if (!map) return { latitude: 0, longitude: 0 };
  const latlng = map.containerPointToLatLng([pxl.x, pxl.y]);
  return { latitude: latlng.lat, longitude: latlng.lng };
}

export interface IListener {
  transform?(ctl: Controller, pzoom: number, end?: boolean): void;
  resize?(ctl: Controller): void;
}

// Tile layer URL templates for different map styles
const TILE_URLS = {
  road: 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
  aerial: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
  grayscale: 'https://{s}.basemaps.cartocdn.com/light_nolabels/{z}/{x}/{y}{r}.png',
  canvasDark: 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
  canvasLight: 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png',
  hidden: ''  // No tiles for hidden mode
};

const LABEL_URLS = {
  road: null, // Labels already included in OSM tiles
  aerial: 'https://{s}.basemaps.cartocdn.com/light_only_labels/{z}/{x}/{y}{r}.png',
  grayscale: 'https://{s}.basemaps.cartocdn.com/light_only_labels/{z}/{x}/{y}{r}.png',
  canvasDark: null, // Labels already included
  canvasLight: null, // Labels already included
  hidden: null
};

const TILE_ATTRIBUTION = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/">CARTO</a>';

declare var L: any;

export class Controller {
  private _div: HTMLDivElement;
  private _map: any; // Leaflet map instance
  private _fmt: IMapFormat;
  private _svg: ISelex;
  private _svgroot: ISelex;
  private _tileLayer: any;
  private _labelLayer: any;
  private _leafletLoaded: boolean = false;

  public get map() { return this._map; }

  public get format() { return this._fmt; }

  public get svg() { return this._svgroot; }

  private _canvas: ISelex;
  public get canvas() { return this._canvas; }

  public location(p: IPoint): ILocation {
    if (!this._map) return { latitude: 0, longitude: 0 };
    const latlng = this._map.containerPointToLatLng([p.x, p.y]);
    return { latitude: latlng.lat, longitude: latlng.lng };
  }

  public setCenterZoom(center: any, zoom: number) {
    if (this._map) {
      zoom = Math.min(20, Math.max(1, zoom));
      if (center && center.latitude !== undefined) {
        this._map.setView([center.latitude, center.longitude], zoom, { animate: false });
      } else if (center && center.lat !== undefined) {
        this._map.setView([center.lat, center.lng], zoom, { animate: false });
      }
    }
  }

  public pixel(loc: ILocation | IBound, ref?: any): IPoint {
    if ((loc as IBound).anchor) {
      return anchorPixel(this._map, loc as any);
    }
    else {
      return pixel(this._map, loc as any, ref);
    }
  }

  public anchor(locs: ILocation[]) { return anchor(locs); }

  public area(locs: ILocation[], level = 20) { return area(locs, level); }

  public bound(locs: ILocation[]): IBound { return bound(locs); }

  private _listener = [] as IListener[];
  public add(v: IListener) { this._listener.push(v); return this; }

  public fitView(areas: IBound[], backupCenter?: ILocation) {
    if (!this._map) return;
    const container = this._map.getContainer();
    const width = container.clientWidth, height = container.clientHeight;
    const config = fitOptions(areas, { width, height });
    const minZoom = this._map.getMinZoom();
    let zoom = config.zoom;
    let center = config.center;
    if (zoom < minZoom) {
      zoom = minZoom;
      if (backupCenter) {
        center = { latitude: backupCenter.latitude, longitude: backupCenter.longitude };
      }
    }
    this._map.setView([center.latitude, center.longitude], zoom, { animate: false });
    this._viewChange(false);
  }

  constructor(id: string) {
    const div = selex(id).node<HTMLDivElement>();
    this._fmt = {} as IMapFormat;
    this._div = div;
    let config = (root: ISelex) => {
      root.att.tabIndex(-1)
        .sty.pointer_events('none')
        .sty.position('absolute')
        .sty.visibility('inherit')
        .sty.user_select('none');
      return root;
    };
    this._canvas = config(selex(div).append('canvas'));
    this._svg = config(selex(div).append('svg'));
    this._svgroot = this._svg.append('g').att.id('root');
  }

  private _initMap(): void {
    // Clear any existing map content
    const existingMapDivs = this._div.querySelectorAll('.leaflet-container');
    existingMapDivs.forEach(d => d.remove());

    // Create a new div for the Leaflet map
    const mapDiv = document.createElement('div');
    mapDiv.style.width = '100%';
    mapDiv.style.height = '100%';
    mapDiv.style.position = 'absolute';
    mapDiv.style.top = '0';
    mapDiv.style.left = '0';
    this._div.insertBefore(mapDiv, this._div.firstChild);

    const center = this._map ? this._map.getCenter() : { lat: 0, lng: 0 };
    const zoom = this._map ? this._map.getZoom() : 2;

    // Remove old map if exists
    if (this._map) {
      try { this._map.remove(); } catch (e) { /* ignore */ }
    }

    this._map = L.map(mapDiv, {
      center: [center.lat || 0, center.lng || 0],
      zoom: zoom || 2,
      zoomControl: false,
      attributionControl: false,
      dragging: this._fmt.pan !== false,
      scrollWheelZoom: this._fmt.zoom !== false,
      doubleClickZoom: this._fmt.zoom !== false,
      touchZoom: this._fmt.zoom !== false,
      boxZoom: this._fmt.zoom !== false,
      keyboard: false
    });

    // Add attribution in corner
    L.control.attribution({ position: 'bottomright', prefix: false })
      .addTo(this._map);

    // Add scale bar if configured
    if (this._fmt.scale) {
      L.control.scale({ position: 'bottomleft' }).addTo(this._map);
    }

    // Set tile layer based on map type
    this._updateTileLayer();

    // Re-attach SVG and Canvas overlays
    const mapContainer = this._map.getContainer();
    const pane = this._map.getPane('overlayPane') || mapContainer;
    if (this._canvas) pane.appendChild(this._canvas.node());
    if (this._svg) pane.appendChild(this._svg.node());

    // Wire up events
    this._map.on('move', () => this._viewChange(false));
    this._map.on('moveend', () => this._viewChange(true));
    this._map.on('zoomend', () => this._viewChange(true));
    this._map.on('resize', () => this._resize());

    if (!this._zoom) {
      this._resize();
    }
    this._zoom = this._map.getZoom();
  }

  private _updateTileLayer(): void {
    if (!this._map) return;

    // Remove existing layers
    if (this._tileLayer) {
      this._map.removeLayer(this._tileLayer);
      this._tileLayer = null;
    }
    if (this._labelLayer) {
      this._map.removeLayer(this._labelLayer);
      this._labelLayer = null;
    }

    const mapType = this._fmt.type || 'road';

    if (mapType === 'hidden') {
      // No tiles - just a white background
      this._map.getContainer().style.backgroundColor = '#FFFFFF';
      return;
    }

    const tileUrl = TILE_URLS[mapType] || TILE_URLS.road;
    this._tileLayer = L.tileLayer(tileUrl, {
      attribution: TILE_ATTRIBUTION,
      maxZoom: 20,
      subdomains: 'abcd'
    }).addTo(this._map);

    // Add separate labels layer if needed and labels are enabled
    if (this._fmt.label !== false) {
      const labelUrl = LABEL_URLS[mapType];
      if (labelUrl) {
        this._labelLayer = L.tileLayer(labelUrl, {
          maxZoom: 20,
          subdomains: 'abcd',
          pane: 'overlayPane'
        }).addTo(this._map);
      }
    }
  }

  private _viewChange(end = false) {
    if (!this._map) return;
    let zoom = this._map.getZoom();
    for (let l of this._listener) {
      l.transform && l.transform(this, this._zoom, end);
    }
    this._zoom = zoom;
  }

  private _zoom: number;

  private _resize(): void {
    if (!this._map) {
      return;
    }
    const container = this._map.getContainer();
    let w = container.clientWidth, h = container.clientHeight;
    this._svg.att.width('100%').att.height('100%');
    this._canvas && this._canvas.att.size(w, h);
    this._svgroot.att.translate(w / 2, h / 2);
    for (let l of this._listener) {
      l.resize && l.resize(this);
    }
  }

  restyle(fmt: Partial<IMapFormat>, then?: Action<any>): Controller {
    then = then || (() => { });
    var dirty = {} as Partial<IMapFormat>;
    for (var k in fmt) {
      if (fmt[k] !== this._fmt[k]) {
        dirty[k] = this._fmt[k] = fmt[k];
      }
    }
    if (keys(dirty).length === 0 && this._map) {
      return this;
    }

    if (!this._leafletLoaded) {
      // Load Leaflet CSS and JS
      this._loadLeaflet(() => {
        this._leafletLoaded = true;
        this._initMap();
        then(this._map);
      });
      return this;
    }

    // Check if we need to reinitialize the map or just update layers
    if ('lang' in dirty || 'type' in dirty || !this._map) {
      this._initMap();
      then(this._map);
      return this;
    }

    const remap = { label: 1, forest: 1, road: 1, city: 1, icon: 1, area: 1, building: 1 };
    let needTileUpdate = false;
    for (var k in dirty) {
      if (k in remap) {
        needTileUpdate = true;
        break;
      }
    }

    if (needTileUpdate) {
      this._updateTileLayer();
    }

    if ('pan' in dirty) {
      if (dirty.pan) {
        this._map.dragging.enable();
      } else {
        this._map.dragging.disable();
      }
    }
    if ('zoom' in dirty) {
      if (dirty.zoom) {
        this._map.scrollWheelZoom.enable();
        this._map.doubleClickZoom.enable();
        this._map.touchZoom.enable();
        this._map.boxZoom.enable();
      } else {
        this._map.scrollWheelZoom.disable();
        this._map.doubleClickZoom.disable();
        this._map.touchZoom.disable();
        this._map.boxZoom.disable();
      }
    }
    if ('scale' in dirty) {
      // Scale bar toggle requires re-init
      this._initMap();
    }

    then(null);
    return this;
  }

  private _loadLeaflet(callback: () => void): void {
    // Check if Leaflet is already loaded
    if (typeof L !== 'undefined') {
      callback();
      return;
    }

    // Load Leaflet CSS
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css';
    link.integrity = 'sha256-p4NxAoJBhIIN+hmNHrzRCf9tD/miZyoHS5obTRR9BMY=';
    link.crossOrigin = '';
    document.head.appendChild(link);

    // Load Leaflet JS
    const script = document.createElement('script');
    script.src = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js';
    script.integrity = 'sha256-20nQCchB9co0qIjJZRGuk2/Z9VM+kNiyxNV1lvTlZBo=';
    script.crossOrigin = '';
    script.onload = () => {
      callback();
    };
    script.onerror = () => {
      console.error('Failed to load Leaflet. Retrying without integrity check...');
      // Fallback: try without integrity
      const fallback = document.createElement('script');
      fallback.src = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js';
      fallback.onload = () => callback();
      document.head.appendChild(fallback);
    };
    document.head.appendChild(script);
  }
}
