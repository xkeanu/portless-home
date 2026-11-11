class HomeportApp < Formula
  desc "Menu bar app for homeport: running apps, health dots, service start/stop"
  homepage "https://github.com/xkeanu/homeport"
  license "MIT"
  head "https://github.com/xkeanu/homeport.git", branch: "main"

  depends_on macos: :ventura

  def install
    ENV["SWIFT_BUILD_FLAGS"] = "--disable-sandbox"
    system "macos/build.sh", buildpath
    prefix.install "Homeport.app"
  end

  def caveats
    <<~EOS
      Built on this machine, so no Gatekeeper prompt. Link it into
      ~/Applications so Spotlight and Launchpad find it:
        mkdir -p ~/Applications && ln -sf "#{opt_prefix}/Homeport.app" ~/Applications/
      Open it once from there; "Launch at login" is in its menu.
    EOS
  end

  test do
    app = prefix/"Homeport.app/Contents"
    assert_predicate app/"MacOS/Homeport", :executable?
    assert_match "sh.homeport.menubar", shell_output("plutil -extract CFBundleIdentifier raw -o - #{app}/Info.plist")
  end
end
