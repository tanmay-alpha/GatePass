<?php
/*
Plugin Name: CTech QR Integration
Description: Adds QR Code Toolkit integration hooks for YOURLS.
Version: 0.1.0
Author: CompleteTech LLC
*/

if (!defined('YOURLS_ABSPATH')) {
    die();
}

const CTECH_QR_PLUGIN_VERSION = '20260507-0001';

yourls_add_filter('api_action_ctech_qr_ping', 'ctech_qr_api_ping');
yourls_add_filter('table_add_row_action_array', 'ctech_qr_table_action', 10, 2);

function ctech_qr_studio_url() {
    return defined('CTECH_QR_STUDIO_URL')
        ? rtrim(CTECH_QR_STUDIO_URL, '/')
        : 'http://localhost:3000';
}

function ctech_qr_api_ping($return) {
    return array(
        'statusCode' => 200,
        'simple' => 'ctech-qr-ok',
        'message' => 'CTech QR Integration is active.',
        'version' => CTECH_QR_PLUGIN_VERSION,
    );
}

function ctech_qr_table_action($actions, $keyword) {
    $shorturl = yourls_link($keyword);
    $href = ctech_qr_studio_url() . '/?url=' . rawurlencode($shorturl);

    $actions['ctech_qr'] = sprintf(
        '<a href="%s" title="%s" rel="noopener">QR</a>',
        yourls_esc_url($href),
        yourls_esc_attr('Open in QR Code Toolkit')
    );

    return $actions;
}
