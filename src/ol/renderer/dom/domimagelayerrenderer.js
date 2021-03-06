goog.provide('ol.renderer.dom.ImageLayer');

goog.require('goog.dom');
goog.require('goog.vec.Mat4');
goog.require('ol.Image');
goog.require('ol.ImageState');
goog.require('ol.ViewHint');
goog.require('ol.dom');
goog.require('ol.layer.ImageLayer');
goog.require('ol.renderer.dom.Layer');



/**
 * @constructor
 * @extends {ol.renderer.dom.Layer}
 * @param {ol.renderer.Map} mapRenderer Map renderer.
 * @param {ol.layer.ImageLayer} imageLayer Image layer.
 */
ol.renderer.dom.ImageLayer = function(mapRenderer, imageLayer) {
  var target = goog.dom.createElement(goog.dom.TagName.DIV);
  target.className = 'ol-layer-image';
  target.style.position = 'absolute';

  goog.base(this, mapRenderer, imageLayer, target);

  /**
   * The last rendered image.
   * @private
   * @type {?ol.Image}
   */
  this.image_ = null;

  /**
   * @private
   * @type {goog.vec.Mat4.AnyType}
   */
  this.transform_ = goog.vec.Mat4.createNumberIdentity();

};
goog.inherits(ol.renderer.dom.ImageLayer, ol.renderer.dom.Layer);


/**
 * @return {ol.layer.ImageLayer} Image layer.
 */
ol.renderer.dom.ImageLayer.prototype.getImageLayer = function() {
  return /** @type {ol.layer.ImageLayer} */ (this.getLayer());
};


/**
 * @inheritDoc
 */
ol.renderer.dom.ImageLayer.prototype.renderFrame =
    function(frameState, layerState) {

  var view2DState = frameState.view2DState;
  var viewCenter = view2DState.center;
  var viewResolution = view2DState.resolution;
  var viewRotation = view2DState.rotation;

  var image = this.image_;
  var imageLayer = this.getImageLayer();
  var imageSource = imageLayer.getImageSource();

  var hints = frameState.viewHints;

  if (!hints[ol.ViewHint.ANIMATING] && !hints[ol.ViewHint.INTERACTING]) {
    var image_ = imageSource.getImage(
        frameState.extent, viewResolution, view2DState.projection);
    if (!goog.isNull(image_)) {
      var imageState = image_.getState();
      if (imageState == ol.ImageState.IDLE) {
        goog.events.listenOnce(image_, goog.events.EventType.CHANGE,
            this.handleImageChange, false, this);
        image_.load();
      } else if (imageState == ol.ImageState.LOADED) {
        image = image_;
      }
    }
  }

  if (!goog.isNull(image)) {
    var imageExtent = image.getExtent();
    var imageResolution = image.getResolution();
    var transform = goog.vec.Mat4.createNumber();
    goog.vec.Mat4.makeIdentity(transform);
    goog.vec.Mat4.translate(transform,
        frameState.size.width / 2, frameState.size.height / 2, 0);
    goog.vec.Mat4.rotateZ(transform, viewRotation);
    goog.vec.Mat4.scale(
        transform,
        imageResolution / viewResolution,
        imageResolution / viewResolution,
        1);
    goog.vec.Mat4.translate(
        transform,
        (imageExtent.minX - viewCenter.x) / imageResolution,
        (viewCenter.y - imageExtent.maxY) / imageResolution,
        0);
    if (image != this.image_) {
      var imageElement = image.getImageElement(this);
      imageElement.style.position = 'absolute';
      goog.dom.removeChildren(this.target);
      goog.dom.appendChild(this.target, imageElement);
      this.image_ = image;
    }
    this.setTransform(transform);

    this.updateAttributions(frameState.attributions, image.getAttributions());
  }

};


/**
 * @param {goog.vec.Mat4.AnyType} transform Transform.
 */
ol.renderer.dom.ImageLayer.prototype.setTransform = function(transform) {
  if (!goog.vec.Mat4.equals(transform, this.transform_)) {
    ol.dom.transformElement2D(this.target, transform, 6);
    goog.vec.Mat4.setFromArray(this.transform_, transform);
  }
};
