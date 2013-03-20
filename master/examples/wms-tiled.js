var layers = [
  new ol.layer.TileLayer({
    source: new ol.source.MapQuestOpenAerial()
  }),
  new ol.layer.TileLayer({
    source: new ol.source.TiledWMS({
      url: 'http://demo.opengeo.org/geoserver/wms',
      crossOrigin: null,
      params: {'LAYERS': 'topp:states', 'TILED': true},
      extent: new ol.Extent(-13884991, 2870341, -7455066, 6338219)
    })
  })
];
var map = new ol.Map({
  renderer: ol.RendererHint.CANVAS,
  layers: layers,
  target: 'map',
  view: new ol.View2D({
    center: new ol.Coordinate(-10997148, 4569099),
    zoom: 4
  })
});
