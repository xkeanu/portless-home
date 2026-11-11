class Homeport < Formula
  desc "Tailnet home page listing your running portless apps"
  homepage "https://github.com/xkeanu/homeport"
  license "MIT"
  head "https://github.com/xkeanu/homeport.git", branch: "main"

  depends_on "node"

  def install
    system "npm", "ci", "--ignore-scripts"
    system "npm", "run", "build"
    libexec.install "server.mjs", "render.mjs", "i18n.mjs", "peers.mjs", "menubar.mjs", "live.mjs", "launch.mjs", "external.mjs", "projects.mjs", "access.mjs", "dist"
    libexec.install "accounts.mjs", "accounts-http.mjs", "accounts-cli.mjs", "account-store.mjs",
                    "account-providers.mjs", "account-processes.mjs", "account-routing.mjs", "account-sync.mjs"
    pkgshare.install "menubar"
    (bin/"homeport").write <<~SH
      #!/bin/sh
      exec "#{formula_opt_bin("node")}/node" "#{libexec}/server.mjs" "$@"
    SH
    (bin/"homeport").chmod 0755
    (bin/"homeport-accounts").write <<~SH
      #!/bin/sh
      exec "#{formula_opt_bin("node")}/node" "#{libexec}/accounts-cli.mjs" "$@"
    SH
    (bin/"homeport-accounts").chmod 0755
  end

  def caveats
    <<~EOS
      Start now and at every login:
        brew services start homeport
      Start now only (no start at login):
        brew services run homeport

      Then pin it to :443 of your tailnet device URL (persists across reboots):
        tailscale serve --bg --https=443 http://127.0.0.1:5995

      When uninstalling, remove that serve rule too:
        tailscale serve --https=443 off

      Menu bar (xbar/SwiftBar) plugin, to symlink into your plugin folder:
        #{opt_pkgshare}/menubar/homeport.15s.sh

      Optional CLI account management:
        homeport-accounts enable
        homeport-accounts capture claude --label Work
        homeport-accounts --help
      Sign in through the provider CLI before capturing an account.
    EOS
  end

  service do
    run [opt_bin/"homeport"]
    keep_alive true
    log_path var/"log/homeport.log"
    error_log_path var/"log/homeport.log"
  end

  test do
    (testpath/"routes.json").write "[]"
    port = free_port
    pid = spawn({ "PORT" => port.to_s, "PORTLESS_ROUTES" => (testpath/"routes.json").to_s,
                  "PORTLESS_ACCOUNTS" => (testpath/"account-config.json").to_s },
                (bin/"homeport").to_s)
    sleep 2
    assert_match "dev apps", shell_output("curl -sf http://127.0.0.1:#{port}/")
    assert_predicate libexec/"dist/ui-server.mjs", :exist?
    assert_match "Account management is off", shell_output("curl -sf http://127.0.0.1:#{port}/accounts")
    assert_match "capture", shell_output("#{bin}/homeport-accounts --help")
    assert_match '"enabled":true', shell_output("PORTLESS_ACCOUNTS=#{testpath}/account-config.json #{bin}/homeport-accounts enable")
    assert_predicate testpath/"account-config.json", :exist?
  ensure
    Process.kill("TERM", pid) if pid
  end
end
