import { copy } from '../type';
import { ILocation } from './converter';
import { Func, StringMap, keys } from '../type';


var _injected = {} as StringMap<ILocation>;

export function inject(locs: StringMap<ILocation>, reset = false): void {
    locs = locs || {};
    if (reset) {
        _injected = locs;
        return;
    }
    for (var key of keys(locs)) {
        var loc = locs[key];
        if (loc) {
            _injected[key] = loc;
        }
        else {
            delete _injected[key];
        }
    }
}

export function remove(where: Func<ILocation, boolean>): void {
    for (var key of keys(_injected)) {
        if (where(_injected[key])) {
            delete _injected[key];
        }
    }
}

export function latitude(addr: string): number {
    var loc = query(addr);
    if (loc) {
        return loc.latitude;
    }
    else {
        return null;
    }
}

export function longitude(addr: string): number{
    var loc = query(addr);
    if (loc) {
        return loc.longitude;
    }
    else {
        return null;
    }
}

export function query(addr: string): ILocation;
export function query(addr: string, then: Func<ILocation, void>): void;
export function query(addr: string, then?: Func<ILocation, void>): any {
    if (then) {
        var loc = _injected[addr];
        if (loc) {
            loc.address = addr;
            then(loc);
        }
        else if (addr in _initCache) {
            loc = _initCache[addr];
            loc.address = addr;
            then(loc);
        }
        else {
            geocodeCore(new GeocodeQuery(addr), then);
        }
        return undefined;
    }
    else {
        if (_injected[addr]) {
            return _injected[addr];
        }
        else if (_initCache[addr]) {
            return _initCache[addr];
        }
        var rec = geocodeCache[addr.toLowerCase()];
        if (rec) {
            rec.query.incrementCacheHit();
            return rec.coordinate;
        }
        return null;
    }
}

var _initCache = {} as StringMap<ILocation>;
export function initCache(locs: StringMap<ILocation>) {
    _initCache = copy(locs);
}

export var settings = {
    // Maximum concurrent requests at once.
    MaxBingRequest: 6,

    // Maximum cache size of cached geocode data.
    MaxCacheSize: 3000,

    // Maximum cache overflow of cached geocode data to kick the cache reducing.
    MaxCacheSizeOverflow: 1000,

    // Nominatim URL
    NominatimURL: "https://nominatim.openstreetmap.org/search?",
};

//private
    interface IGeocodeQuery {
        query: string;
        longitude?: number;
        latitude?: number;
    }

    interface IGeocodeCache {
        query: GeocodeQuery;
        coordinate: ILocation;
    }

    interface IGeocodeQueueItem {
        query: GeocodeQuery;
        then: (v: ILocation) => void;
    }

    var geocodeCache: { [key: string]: IGeocodeCache; };
    var geocodeQueue: IGeocodeQueueItem[];
    var activeRequests;

    class GeocodeQuery implements IGeocodeQuery {
        public query      : string;
        public key        : string;
        private _cacheHits: number;
        
        constructor(query: string = "") {
            this.query      = query;
            this.key        = this.query.toLowerCase();
            this._cacheHits = 0;
        }

        public incrementCacheHit(): void {
            this._cacheHits++;
        }

        public getCacheHits(): number {
            return this._cacheHits;
        }

        public getUrl(): string {
            var url = settings.NominatimURL + "format=json&limit=20";
            if (isNaN(+this.query)) {
                url += "&q=" + encodeURIComponent(this.query);
            }
            else {
                url += "&postalcode=" + encodeURIComponent(this.query);
            }

            var cultureName = navigator['userLanguage'] || navigator["language"];
            if (cultureName) {
                url += "&accept-language=" + cultureName;
            }
            return url;
        }
    }

    function findInCache(query: GeocodeQuery): ILocation {
        var pair = geocodeCache[query.key];
        if (pair) {
            pair.query.incrementCacheHit();
            return pair.coordinate;
        }
        return undefined;
    }

    function cacheQuery(query: GeocodeQuery, coordinate: ILocation): void {
        var keys = Object.keys(geocodeCache);
        var cacheSize = keys.length;

        if (Object.keys(geocodeCache).length > (settings.MaxCacheSize + settings.MaxCacheSizeOverflow)) {

            var sorted = keys.sort((a: string, b: string) => {                
                var ca = geocodeCache[a].query.getCacheHits();
                var cb = geocodeCache[b].query.getCacheHits();
                return ca < cb ? -1 : (ca > cb ? 1 : 0);
            });

            for (var i = 0; i < (cacheSize - settings.MaxCacheSize); i++) {
                delete geocodeCache[sorted[i]];
            }
        }

        geocodeCache[query.key] = { query: query, coordinate: coordinate };
    }

    function geocodeCore(geocodeQuery: GeocodeQuery, then: (v: ILocation) => void): void {
        var result = findInCache(geocodeQuery);
        if (result) {
            result.address = geocodeQuery.query;
            then(result);
        } else {
            geocodeQueue.push({ query: geocodeQuery, then: then });
            releaseQuota();
        }
    }

    // export function batch(queries: string[])

    export function getCacheSize(): number {
        return Object.keys(geocodeCache).length;
    }

    function releaseQuota(decrement: number = 0) {
        activeRequests -= decrement;
        while (activeRequests < settings.MaxBingRequest) {
            if (geocodeQueue.length == 0) {
                break;
            }
            activeRequests++;
            makeRequest(geocodeQueue.shift());
        }
    }

    function makeRequest(item: IGeocodeQueueItem) {
        // Check again if we already got the coordinate;
        var result = findInCache(item.query);
        if (result) {
            result.address = item.query.query;
            setTimeout(() => releaseQuota(1));
            item.then(result);
            return;
        }

        var url = item.query.getUrl();

        fetch(url, {
            headers: {
                'Accept': 'application/json'
            }
        })
        .then(response => {
            if (!response.ok) {
                completeRequest(item, new Error("Nominatim request failed: " + response.status), null);
                return;
            }
            return response.json();
        })
        .then(data => {
            if (!data) {
                return; // error already handled above
            }
            if (!Array.isArray(data) || data.length < 1) {
                completeRequest(item, ERROR_EMPTY, null);
                return;
            }
            var error = null as Error, result = null as ILocation;
            try {
                var best = data[0];
                result = {
                    latitude: +best.lat,
                    longitude: +best.lon,
                    type: best.type || best["class"],
                    name: best.display_name
                } as ILocation;
            }
            catch (e) {
                error = e;
            }
            completeRequest(item, error, result);
        })
        .catch(e => {
            completeRequest(item, e, null);
        });
    }

    var ERROR_EMPTY = new Error("Geocode result is empty.");
    var dequeueTimeoutId;

    function completeRequest(item: IGeocodeQueueItem, error: Error, coordinate: ILocation = null) {
        dequeueTimeoutId = setTimeout(() => releaseQuota(1), 0);
        if (error) {
            item.then(undefined);
        }
        else {
            cacheQuery(item.query, coordinate);
            coordinate.address = item.query.query;
            item.then(coordinate);
        }
    }

    function reset(): void {
        geocodeCache = {};
        geocodeQueue = [];
        activeRequests = 0;
        clearTimeout(dequeueTimeoutId);
        dequeueTimeoutId = null;
    }

    reset();
