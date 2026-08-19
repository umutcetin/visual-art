/*
 * presets.js — parameter defaults and the four named looks.
 */
(function (root) {
  'use strict';
  var GA = (root.GA = root.GA || {});

  var DEFAULTS = {
    shapes: 5,
    layout: 'scatter',   // scatter | grid | cluster
    geometry: 0.15,      // 0 = organic blob, 1 = soft polygon
    scale: 1,
    layers: 12,
    spacing: 14,
    lineWidth: 1.1,
    distortion: 0.35,
    repulsion: 0.35,
    merge: 0.35,
    gapProb: 0.12,
    secondary: 0.3
  };

  var PRESETS = [
    {
      id: 'topographic',
      name: 'Topographic',
      note: 'Even, calm contour lines — a survey map.',
      params: {
        shapes: 5, layout: 'scatter', geometry: 0.08, scale: 1,
        layers: 15, spacing: 11.5, lineWidth: 0.95,
        distortion: 0.22, repulsion: 0.34, merge: 0.35,
        gapProb: 0.05, secondary: 0.18
      }
    },
    {
      id: 'organic',
      name: 'Organic',
      note: 'More deformation, asymmetry and merging.',
      params: {
        shapes: 6, layout: 'scatter', geometry: 0.05, scale: 1.05,
        layers: 11, spacing: 15, lineWidth: 1.15,
        distortion: 0.62, repulsion: 0.2, merge: 0.62,
        gapProb: 0.14, secondary: 0.5
      }
    },
    {
      id: 'tile',
      name: 'Tile',
      note: 'Structured and decorative, soft ceramic geometry.',
      params: {
        shapes: 9, layout: 'grid', geometry: 0.8, scale: 0.9,
        layers: 11, spacing: 14, lineWidth: 1.3,
        distortion: 0.12, repulsion: 0.62, merge: 0.18,
        gapProb: 0.04, secondary: 0.1
      }
    },
    {
      id: 'ruins',
      name: 'Ruins',
      note: 'Sparse and architectural, slowly overgrown.',
      params: {
        shapes: 5, layout: 'cluster', geometry: 0.6, scale: 1.2,
        layers: 6, spacing: 22, lineWidth: 1.2,
        distortion: 0.72, repulsion: 0.72, merge: 0.15,
        gapProb: 0.38, secondary: 0.65
      }
    }
  ];

  GA.DEFAULTS = DEFAULTS;
  GA.PRESETS = PRESETS;
  GA.presetById = function (id) {
    for (var i = 0; i < PRESETS.length; i++) if (PRESETS[i].id === id) return PRESETS[i];
    return null;
  };
})(typeof window !== 'undefined' ? window : globalThis);
