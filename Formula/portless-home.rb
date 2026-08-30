class PortlessHome < Formula
  desc "Tailnet home page listing your running portless apps"
  homepage "https://github.com/xkeanu/portless-home"
  license "MIT"
  head "https://github.com/xkeanu/portless-home.git", branch: "main"

  depends_on "node"

  def install
    libexec.install "server.mjs", "render.mjs"
    (bin/"portless-home").write <<~SH
      #!/bin/sh
      exec "#{formula_opt_bin("node")}/node" "#{libexec}/server.mjs" "$@"
    SH
    (bin/"portless-home").chmod 0755
  end

  def caveats
    <<~EOS
      Start now and at every login:
        brew services start portless-home
      Start now only (no start at login):
        brew services run portless-home

      Then pin it to :443 of your tailnet device URL (persists across reboots):
        tailscale serve --bg --https=443 http://127.0.0.1:5995

      When uninstalling, remove that serve rule too:
        tailscale serve --https=443 off
    EOS
  end

  service do
    run [opt_bin/"portless-home"]
    keep_alive true
    log_path var/"log/portless-home.log"
    error_log_path var/"log/portless-home.log"
  end

  test do
    (testpath/"routes.json").write "[]"
    port = free_port
    pid = spawn({ "PORT" => port.to_s, "PORTLESS_ROUTES" => (testpath/"routes.json").to_s },
                (bin/"portless-home").to_s)
    sleep 2
    assert_match "dev apps", shell_output("curl -sf http://127.0.0.1:#{port}/")
  ensure
    Process.kill("TERM", pid) if pid
  end
end
