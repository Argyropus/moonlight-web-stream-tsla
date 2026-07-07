use std::time::Duration;

use bytes::Bytes;
use log::debug;
use pem::Pem;
use reqwest::{Certificate, Client, ClientBuilder, Identity};
use thiserror::Error;
use url::{ParseError, Url};

use crate::network::{
    ApiError,
    request_client::{QueryParamsRef, RequestClient},
};

#[cfg(feature = "high")]
pub type ReqwestMoonlightHost = crate::high::MoonlightHost<reqwest::Client>;

#[derive(Debug, Error)]
pub enum ReqwestError {
    #[error("{0}")]
    Reqwest(#[from] reqwest::Error),
    #[error("{0}")]
    UrlParse(#[from] ParseError),
}
pub type ReqwestApiError = ApiError<ReqwestError>;

fn default_builder() -> ClientBuilder {
    ClientBuilder::new()
        .use_native_tls()
        .connect_timeout(Duration::from_secs(1))
        .timeout(Duration::from_secs(90))
        // https://github.com/seanmonstar/reqwest/issues/2021
        .pool_max_idle_per_host(0)
}
fn timeout_builder() -> ClientBuilder {
    default_builder().timeout(Duration::from_secs(2))
}

fn build_client_with_certificates(
    builder: ClientBuilder,
    client_private_key: &Pem,
    client_certificate: &Pem,
    server_certificate: &Pem,
) -> Result<Client, ReqwestError> {
    let server_cert = Certificate::from_pem(server_certificate.to_string().as_bytes())?;

    let identity = Identity::from_pkcs8_pem(
        client_certificate.to_string().as_bytes(),
        client_private_key.to_string().as_bytes(),
    )?;

    Ok(builder
        .tls_built_in_root_certs(false)
        .add_root_certificate(server_cert)
        .identity(identity)
        .danger_accept_invalid_hostnames(true)
        .build()?)
}

fn build_url(
    use_https: bool,
    hostport: &str,
    path: &str,
    query_params: &QueryParamsRef<'_>,
) -> Result<Url, ReqwestError> {
    let protocol = if use_https { "https" } else { "http" };

    let authority = format!("{protocol}://{hostport}/{path}");
    let url = Url::parse_with_params(&authority, query_params)?;

    debug!("Request: {url}");

    Ok(url)
}

impl RequestClient for Client {
    type Error = ReqwestError;

    type Text = String;
    type Bytes = Bytes;

    fn with_defaults_long_timeout() -> Result<Self, Self::Error> {
        Ok(default_builder().build()?)
    }
    fn with_defaults() -> Result<Self, Self::Error> {
        Ok(timeout_builder().build()?)
    }

    fn with_certificates(
        client_private_key: &Pem,
        client_certificate: &Pem,
        server_certificate: &Pem,
    ) -> Result<Self, Self::Error> {
        build_client_with_certificates(
            timeout_builder(),
            client_private_key,
            client_certificate,
            server_certificate,
        )
    }

    fn with_certificates_long_timeout(
        client_private_key: &Pem,
        client_certificate: &Pem,
        server_certificate: &Pem,
    ) -> Result<Self, Self::Error> {
        build_client_with_certificates(
            default_builder(),
            client_private_key,
            client_certificate,
            server_certificate,
        )
    }

    async fn send_http_request_text_response(
        &mut self,
        hostport: &str,
        path: &str,
        query_params: &QueryParamsRef<'_>,
    ) -> Result<Self::Text, Self::Error> {
        let url = build_url(false, hostport, path, query_params)?;
        Ok(self.get(url).send().await?.text().await?)
    }

    async fn send_https_request_text_response(
        &mut self,
        hostport: &str,
        path: &str,
        query_params: &QueryParamsRef<'_>,
    ) -> Result<Self::Text, Self::Error> {
        let url = build_url(true, hostport, path, query_params)?;
        Ok(self.get(url).send().await?.text().await?)
    }

    async fn send_https_request_data_response(
        &mut self,
        hostport: &str,
        path: &str,
        query_params: &QueryParamsRef<'_>,
    ) -> Result<Self::Bytes, Self::Error> {
        let url = build_url(true, hostport, path, query_params)?;
        Ok(self.get(url).send().await?.bytes().await?)
    }
}
