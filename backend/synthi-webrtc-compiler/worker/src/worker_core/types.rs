use serde::{Deserialize, Serialize};
use webrtc::ice_transport::ice_candidate::RTCIceCandidateInit;
use webrtc::track::track_local::track_local_static_rtp::TrackLocalStaticRTP;
use std::sync::Arc;
use tokio::sync::mpsc;
use gstreamer as gst;

#[derive(Debug, Deserialize)]
pub struct IceServerEnv {
    pub urls: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub username: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub credential: Option<String>,
}

pub const REQUIRED_TOOLS: &[&str] = &["g++", "rustc", "tsc", "clangd"];
pub const GUI_TOOLS: &[&str] = &["xdotool", "Xvfb", "matchbox-window-manager"];

pub const GUI_LIBRARY_SIGNATURES: &[(&str, &[&str])] = &[
    ("python", &["import tkinter", "import pygame", "import PyQt5", "import PySide2", "import kivy"]),
    ("cpp", &["#include <gtk/gtk.h>", "#include <QApplication>", "#include <SDL2/SDL.h>", "#include <GL/glut.h>", "#include <X11/"]),
    ("cpp_legacy", &["#include <gtk/gtk.h>", "#include <QApplication>", "#include <SDL2/SDL.h>", "#include <GL/glut.h>", "#include <X11/"]),
    ("rust", &["use gtk", "use iced", "use druid", "use winit", "use macroquad"]),
    ("java", &["import javax.swing", "import javafx"]),
];

#[derive(Debug, Serialize, Deserialize)]
pub struct SignalMessage {
    #[serde(rename = "type")]
    pub msg_type: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub role: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sdp: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sdp_type: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub candidate: Option<RTCIceCandidateInit>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct FileEntry {
    pub name: String,
    pub content: String,
}

#[derive(Debug, Deserialize)]
pub struct CompileRequest {
    pub language: String,
    pub filename: String,
    pub source: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    #[serde(default)]
    pub files: Vec<FileEntry>,
    #[serde(default)]
    pub is_gui: bool,
    #[serde(default)]
    pub width: Option<u32>,
    #[serde(default)]
    pub height: Option<u32>,
    #[serde(default)]
    pub supports_h265: Option<bool>,
    #[serde(default)]
    pub use_ai_split: bool,
}

pub struct RunnerState {
    pub process: Option<tokio::process::Child>,
    pub stdin: tokio::process::ChildStdin,
    pub output_tx: tokio::sync::broadcast::Sender<String>,
    pub is_gui: bool,
    pub xvfb_process: Option<tokio::process::Child>,
    pub gst_pipeline: Option<gst::Pipeline>,
    pub x11_tx: Option<mpsc::UnboundedSender<String>>,
    pub video_track: Option<Arc<TrackLocalStaticRTP>>,
    pub audio_track: Option<Arc<TrackLocalStaticRTP>>,
    pub width: u32,
    pub height: u32,
    pub wsl_display_str: String,
    pub gst_display_str: String,
}

pub struct LspSessionState {
    pub client_root_uri: Option<String>,
    pub server_root_uri: String,
}
