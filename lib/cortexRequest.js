import { selectEndpoint } from './requestExecutor.js';

class CortexRequest {
    constructor( { url, data, params, headers, cache, model, pathwayResolver, selectedEndpoint } = {}) { 
        this._url = url || '';
        this._data = data || {};
        this._params = params || {};
        this._headers = headers || {};
        this._cache = cache || {};
        this._model = model || '';
        this._pathwayResolver = pathwayResolver || {};
        this._selectedEndpoint = selectedEndpoint || {};

        if (this._pathwayResolver) {
            this._model = this._pathwayResolver.model;
        }

        if (this._model) {
            this.selectNewEndpoint();
        }
    }

    selectNewEndpoint() {
        const sep = selectEndpoint(this._model);
        if (sep) {
            this._selectedEndpoint = sep;
            this._url = sep.url;
            this._data = { ...this._data, ...sep.params };
            this._headers = { ...this._headers, ...sep.headers };
            this._params = { ...this._params, ...sep.params };
        }
    }

    // url getter and setter
    get url() {
        return this._url;
    }

    set url(value) {
        this._url = value;
    }

    // data getter and setter
    get data() {
        return this._data;
    }

    set data(value) {
        this._data = value;
    }

    // params getter and setter
    get params() {
        return this._params;
    }

    set params(value) {
        this._params = value;
    }

    // headers getter and setter
    get headers() {
        return this._headers;
    }

    set headers(value) {
        this._headers = value;
    }

    // cache getter and setter
    get cache() {
        return this._cache;
    }

    set cache(value) {
        this._cache = value;
    }

    // model getter and setter
    get model() {
        return this._model;
    }

    set model(value) {
        this._model = value;
    }

    // requestId getter
    get requestId() {
        return this._pathwayResolver.requestId;
    }

    // pathway getter and setter
    get pathway() {
        return this._pathwayResolver.pathway;
    }

    // selectedEndpoint getter and setter
    get selectedEndpoint() {
        return this._selectedEndpoint;
    }

    set selectedEndpoint(value) {
        this._selectedEndpoint = value;
    }

    // pathwayResolver getter and setter
    get pathwayResolver() {
        return this._pathwayResolver;
    }

    set pathwayResolver(value) {
        this._pathwayResolver = value;
    }
}

export default CortexRequest;