package com.pocketserver.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

import java.io.File;
import java.io.FileOutputStream;
import java.io.OutputStreamWriter;
import java.io.Writer;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;

/**
 * The phone build must keep starting one PocketBase on 8090 out of the folders every
 * earlier version used, and must not move anything for an existing install.
 *
 * These run on the JVM (no device, no Android framework): ./gradlew testLiteDebugUnitTest
 */
public class SiteRegistryTest {

    @Rule
    public TemporaryFolder folder = new TemporaryFolder();

    private File dataRoot;

    /** stand-in for getFilesDir() */
    private File fresh() throws Exception {
        dataRoot = folder.newFolder("files");
        return dataRoot;
    }

    private void writeRegistry(String json) throws Exception {
        File file = SiteRegistry.registryFile(dataRoot);
        try (Writer writer = new OutputStreamWriter(new FileOutputStream(file), StandardCharsets.UTF_8)) {
            writer.write(json);
        }
    }

    @Test
    public void withoutARegistryThePhoneRunsOneSiteOn8090() throws Exception {
        File root = fresh();

        SiteRegistry registry = SiteRegistry.load(root, 8090);

        assertEquals("exactly one site", 1, registry.sites.size());
        assertTrue("no complaints", registry.problems.isEmpty());

        SiteRegistry.Site site = registry.sites.get(0);
        assertEquals("default", site.id);
        assertTrue("it is the original data folder", site.legacy);
        assertEquals(8090, site.port);
        assertEquals(new File(root, "pb_data").getAbsolutePath(), site.dataDir.getAbsolutePath());
        assertEquals(new File(root, "pb_public").getAbsolutePath(), site.publicDir.getAbsolutePath());
        assertEquals(new File(root, "pb_public/backups").getAbsolutePath(), site.backupDir.getAbsolutePath());
        assertEquals("pocketbase", site.logName);

        assertEquals("the exact command line the service runs",
                Arrays.asList(
                        "/native/libpocketbase.so",
                        "serve",
                        "--http=0.0.0.0:8090",
                        "--dir=" + new File(root, "pb_data").getAbsolutePath(),
                        "--publicDir=" + new File(root, "pb_public").getAbsolutePath()),
                site.serveArgs("/native/libpocketbase.so"));

        assertFalse("nothing is moved into sites/", new File(root, "sites").exists());
    }

    @Test
    public void aRegistryAddsASiteWithoutTouchingTheOriginalFolders() throws Exception {
        File root = fresh();
        writeRegistry("{\"version\":1,\"sites\":["
                + "{\"id\":\"default\",\"name\":\"Primary\",\"port\":8090,\"legacy\":true},"
                + "{\"id\":\"second\",\"name\":\"Second site\",\"port\":8091}]}");

        SiteRegistry registry = SiteRegistry.load(root, 8090);

        assertEquals(2, registry.sites.size());
        assertTrue(registry.problems.isEmpty());

        SiteRegistry.Site first = registry.byId("default");
        SiteRegistry.Site second = registry.byId("second");
        assertNotNull(first);
        assertNotNull(second);
        assertEquals(new File(root, "pb_data").getAbsolutePath(), first.dataDir.getAbsolutePath());
        assertEquals(new File(root, "pb_public").getAbsolutePath(), first.publicDir.getAbsolutePath());
        assertEquals(8091, second.port);
        assertEquals(new File(root, "sites/second/pb_data").getAbsolutePath(), second.dataDir.getAbsolutePath());
        assertEquals(new File(root, "sites/second/pb_public").getAbsolutePath(), second.publicDir.getAbsolutePath());
        assertEquals("site-second", second.logName);
        assertFalse(second.legacy);
        assertEquals("--http=0.0.0.0:8091", second.serveArgs("/native/libpocketbase.so").get(2));
    }

    @Test
    public void aBrokenRegistryStillStartsTheOriginalSite() throws Exception {
        File root = fresh();
        writeRegistry("{ not json");

        SiteRegistry registry = SiteRegistry.load(root, 8090);

        assertEquals(1, registry.sites.size());
        assertEquals("default", registry.sites.get(0).id);
        assertEquals(8090, registry.sites.get(0).port);
        assertFalse("the problem is reported, not thrown", registry.problems.isEmpty());
    }

    @Test
    public void panelPortsAreRefusedAndMissingPortsAreAssigned() throws Exception {
        File root = fresh();
        writeRegistry("{\"sites\":["
                + "{\"id\":\"default\",\"legacy\":true},"
                + "{\"id\":\"bad\",\"port\":8082},"
                + "{\"id\":\"third\"}]}");

        SiteRegistry registry = SiteRegistry.load(root, 8090);

        assertEquals("the original site keeps 8090", 8090, registry.byId("default").port);
        assertNull("8082 belongs to the panel", registry.byId("bad"));
        assertEquals("the next entry gets the next free port", 8091, registry.byId("third").port);
        assertEquals(2, registry.sites.size());
    }

    @Test
    public void duplicateIdsAndPortsAreSkipped() throws Exception {
        File root = fresh();
        writeRegistry("{\"sites\":["
                + "{\"id\":\"default\",\"port\":8090,\"legacy\":true},"
                + "{\"id\":\"default\",\"port\":8092},"
                + "{\"id\":\"twin\",\"port\":8090}]}");

        SiteRegistry registry = SiteRegistry.load(root, 8090);

        assertEquals(1, registry.sites.size());
        assertEquals("both duplicates are explained", 2, registry.problems.size());
    }

    @Test
    public void anUnknownIdResolvesToNothingButABlankOneToTheOriginalSite() throws Exception {
        fresh();
        SiteRegistry registry = SiteRegistry.load(dataRoot, 8090);

        assertNotNull("a blank id means the original site", registry.byId(""));
        assertNotNull(registry.byId("default"));
        assertNull(registry.byId("nope"));
    }
}
