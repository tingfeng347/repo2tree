use anyhow::Result;
use axum::{
    Json, Router,
    extract::{Request, State},
    http::{StatusCode, header},
    middleware::{self, Next},
    response::{Html, IntoResponse, Response},
    routing::{get, post},
};
use serde::Deserialize;
use serde_json::{Value, json};
use std::{path::PathBuf, sync::Arc};
use tokio::sync::{Mutex, RwLock};

#[derive(Clone)]
struct App {
    graph: Arc<RwLock<Value>>,
    scanning: Arc<Mutex<()>>,
    scan_control: Arc<std::sync::Mutex<Option<Arc<crate::scan_job::ScanControl>>>>,
}

pub async fn serve(project: Option<PathBuf>, port: u16, index: bool) -> Result<()> {
    let graph = if let Some(p) = project {
        crate::scan::scan(&p, index)?
    } else {
        serde_json::from_str(include_str!("../examples/demo.project.json"))?
    };
    let state = App {
        graph: Arc::new(RwLock::new(graph)),
        scanning: Arc::new(Mutex::new(())),
        scan_control: Arc::new(std::sync::Mutex::new(None)),
    };
    let app=Router::new()
        .route("/",get(||async {Html(include_str!("../web/index.html"))}))
        .route("/app.js",get(||async {([(header::CONTENT_TYPE,"text/javascript; charset=utf-8")],include_str!("../web/app.js"))}))
        .route("/diagram-workspace.js",get(||async {([(header::CONTENT_TYPE,"text/javascript; charset=utf-8")],include_str!("../web/diagram-workspace.js"))}))
        .route("/diagram-model.js",get(||async {([(header::CONTENT_TYPE,"text/javascript; charset=utf-8")],include_str!("../web/diagram-model.js"))}))
        .route("/diagram-svg.js",get(||async {([(header::CONTENT_TYPE,"text/javascript; charset=utf-8")],include_str!("../web/diagram-svg.js"))}))
        .route("/diagram.css",get(||async {([(header::CONTENT_TYPE,"text/css; charset=utf-8")],include_str!("../web/diagram.css"))}))
        .route("/project-model.js",get(||async {([(header::CONTENT_TYPE,"text/javascript; charset=utf-8")],include_str!("../web/project-model.js"))}))
        .route("/offline.js",get(||async {([(header::CONTENT_TYPE,"text/javascript; charset=utf-8")],include_str!("../web/offline.js"))}))
        .route("/engine.js",get(||async {([(header::CONTENT_TYPE,"text/javascript; charset=utf-8")],include_str!("../web/engine.js"))}))
        .route("/syntax.js",get(||async {([(header::CONTENT_TYPE,"text/javascript; charset=utf-8")],include_str!("../web/syntax.js"))}))
        .route("/vendor/highlight.js",get(||async {([(header::CONTENT_TYPE,"text/javascript; charset=utf-8")],include_str!("../web/vendor/highlight.js"))}))
        .route("/theme.js",get(||async {([(header::CONTENT_TYPE,"text/javascript; charset=utf-8")],include_str!("../web/theme.js"))}))
        .route("/presentation.js",get(||async {([(header::CONTENT_TYPE,"text/javascript; charset=utf-8")],include_str!("../web/presentation.js"))}))
        .route("/vendor/highlight.LICENSE",get(||async {include_str!("../web/vendor/highlight.LICENSE")}))
        .route("/fonts/OFL.txt",get(||async {include_str!("../web/fonts/OFL.txt")}))
        .route("/fonts/AlbertSans.ttf",get(||async {([(header::CONTENT_TYPE,"font/ttf")],include_bytes!("../web/fonts/AlbertSans.ttf").as_slice())}))
        .route("/style.css",get(||async {([(header::CONTENT_TYPE,"text/css; charset=utf-8")],include_str!("../web/style.css"))}))
        .route("/api/project",get(|State(app):State<App>|async move {Json(app.graph.read().await.clone())}))
        .route("/api/demo",post(|State(app):State<App>|async move {
            let Ok(_guard)=app.scanning.try_lock() else { return (StatusCode::CONFLICT, Json(json!({"error":"请先取消当前扫描，再切换示例项目"}))).into_response(); };
            let graph:Value=serde_json::from_str(include_str!("../examples/demo.project.json")).unwrap();
            *app.graph.write().await=graph.clone(); Json(graph).into_response()
        }))
        .route("/api/scan",post(scan))
        .route("/api/scan/status",get(|State(app):State<App>|async move {
            Json(app.scan_control.lock().unwrap().as_ref().map(|c| c.snapshot())
                .unwrap_or_else(|| json!({"running":false})))
        }))
        .route("/api/scan/cancel",post(|State(app):State<App>|async move {
            if let Some(control) = app.scan_control.lock().unwrap().as_ref() { control.cancel(); }
            Json(json!({"message":"正在取消扫描"}))
        }))
        .with_state(state)
        .layer(middleware::from_fn(move |req:Request,next:Next|async move {
            // Local endpoints can read code and start an indexer. Reject cross-site and DNS-rebinding requests.
            let host=req.headers().get(header::HOST).and_then(|h|h.to_str().ok()).unwrap_or("");
            let hosts=[format!("127.0.0.1:{port}"),format!("localhost:{port}")];
            if !hosts.iter().any(|h|h==host) {return StatusCode::FORBIDDEN.into_response();}
            if let Some(origin)=req.headers().get(header::ORIGIN) {
                if !hosts.iter().any(|h|origin.as_bytes()==format!("http://{h}").as_bytes()) {return StatusCode::FORBIDDEN.into_response();}
            }
            let mut res=next.run(req).await;
            res.headers_mut().insert(header::CONTENT_SECURITY_POLICY,"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'".parse().unwrap());
            res.headers_mut().insert(header::CACHE_CONTROL,"no-store".parse().unwrap());
            res.headers_mut().insert(header::X_CONTENT_TYPE_OPTIONS,"nosniff".parse().unwrap());
            res
        }));
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", port)).await?;
    println!("repo2tree 已启动：http://127.0.0.1:{port}  （Ctrl+C 退出）");
    axum::serve(listener, app)
        .with_graceful_shutdown(async {
            let _ = tokio::signal::ctrl_c().await;
        })
        .await?;
    Ok(())
}

#[derive(Deserialize)]
struct ScanRequest {
    path: String,
    #[serde(default)]
    index: bool,
}

async fn scan(State(app): State<App>, Json(body): Json<ScanRequest>) -> Response {
    let Ok(guard) = app.scanning.clone().try_lock_owned() else {
        return (
            StatusCode::CONFLICT,
            Json(json!({"error":"已有扫描正在进行；可查看进度或取消"})),
        )
            .into_response();
    };
    let control = Arc::new(crate::scan_job::ScanControl::default());
    *app.scan_control.lock().unwrap() = Some(control.clone());
    // Own the guard outside the request future: closing a tab must not permit
    // overlapping scans or leave progress permanently marked as running.
    let task = tokio::spawn(async move {
        let _guard = guard;
        let worker_control = control.clone();
        let result = tokio::task::spawn_blocking(move || {
            crate::scan::scan_with_control(&PathBuf::from(body.path), body.index, &worker_control)
        })
        .await;
        let response = match result {
            Ok(Ok(graph)) => {
                // Cancellation arriving during final serialization must not publish a partial scan.
                if let Err(error) = control.check() {
                    let message = error.to_string();
                    control.finish(Some(&message));
                    return (StatusCode::BAD_REQUEST, Json(json!({"error":message})))
                        .into_response();
                }
                *app.graph.write().await = graph.clone();
                control.finish(None);
                Json(graph).into_response()
            }
            Ok(Err(error)) => {
                let message = format!("{error:#}");
                control.finish(Some(&message));
                (StatusCode::BAD_REQUEST, Json(json!({"error":message}))).into_response()
            }
            Err(error) => {
                let message = error.to_string();
                control.finish(Some(&message));
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    Json(json!({"error":message})),
                )
                    .into_response()
            }
        };
        response
    });
    match task.await {
        Ok(response) => response,
        Err(error) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({"error":error.to_string()})),
        )
            .into_response(),
    }
}
