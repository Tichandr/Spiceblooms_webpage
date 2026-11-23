$ErrorActionPreference = 'Stop'
$subscription = 'e1afa19c-b0a6-406b-ba80-d9c0fde7907e'
$resourceGroup = 'SpiceBlooms-Dev'
$app = 'spiceblooms-api-dev'

function Invoke-Azure {
    param([string[]]$Arguments)
    & az @Arguments --subscription $subscription --only-show-errors
    if ($LASTEXITCODE -ne 0) {
        throw 'Azure command failed. Check permissions and complete az login with MFA before retrying.'
    }
}

# B1 is a paid dedicated plan; this upgrade was approved for this storefront.
Invoke-Azure -Arguments @('appservice', 'plan', 'update', '--name', 'spiceblooms-api-dev-plan',
    '--resource-group', $resourceGroup, '--sku', 'B1', '--number-of-workers', '1', '--output', 'none')
Invoke-Azure -Arguments @('webapp', 'config', 'set', '--name', $app, '--resource-group', $resourceGroup,
    '--always-on', 'true', '--output', 'none')
Invoke-Azure -Arguments @('resource', 'update', '--resource-type', 'Microsoft.Web/sites/config',
    '--name', "$app/web", '--resource-group', $resourceGroup,
    '--set', 'properties.healthCheckPath=/health', '--output', 'none')
Invoke-Azure -Arguments @('webapp', 'config', 'appsettings', 'set', '--name', $app,
    '--resource-group', $resourceGroup, '--settings',
    'WEBSITE_WARMUP_PATH=/api/Catalog/items?page=1&pageSize=50', 'WEBSITE_WARMUP_STATUSES=200',
    '--output', 'none')
Invoke-Azure -Arguments @('webapp', 'config', 'show', '--name', $app, '--resource-group', $resourceGroup,
    '--query', '{alwaysOn:alwaysOn,healthCheckPath:healthCheckPath}', '--output', 'json')
Invoke-Azure -Arguments @('appservice', 'plan', 'show', '--name', 'spiceblooms-api-dev-plan',
    '--resource-group', $resourceGroup, '--query', '{sku:sku.name,workers:sku.capacity}', '--output', 'json')

$catalog = Invoke-RestMethod -Uri "https://$app.azurewebsites.net/api/Catalog/items?page=1&pageSize=50" -TimeoutSec 40
if ($null -eq $catalog.itemList -or $catalog.itemList.Count -eq 0) {
    throw 'Catalog verification failed: no products returned.'
}
Write-Output "Catalog verified: $($catalog.itemList.Count) products."
