(function (angular) {
    "use strict";
    angular.module('dashboard.analytics')
        .controller('discoveryTagMappingCtrl', ['$scope', '$rootScope', '$state','analyticsServices', 'genericServices','$timeout', function ($scope,$rootScope,$state,analyticsServices,genSevs,$timeout){
            var disTgMap=this;
            $rootScope.stateItems = $state.params;
            $rootScope.organNewEnt.instanceType=false;
            $rootScope.organNewEnt.provider='0';
            analyticsServices.applyFilter(true,null);
            var treeNames = ['Cloud Management','Discovery','Tag Mapping'];
            $rootScope.$emit('treeNameUpdate', treeNames);
            $scope.newEnt={};
            var fltrObj=$rootScope.filterNewEnt;
            disTgMap.tagOption=[];
            disTgMap.getAllTags =function () {
                $scope.newEnt={};
                if(fltrObj && fltrObj.provider && fltrObj.provider.id) {
                    //$scope.newEnt.providerId = fltrObj.provider.id;
                    $scope.isLoadingTag = true;
                    var param = {
                        inlineLoader: true,
                        url: '/providers/' + fltrObj.provider.id + '/tags'
                    };
                    genSevs.promiseGet(param).then(function (tagResult) {
                        $scope.isLoadingTag = false;
                        disTgMap.tagOption = tagResult;
                    });
                }
            };
            disTgMap.getTagValues= function (type,tagName,valueType) {
                if(tagName) {
                    var param = {
                        inlineLoader: true,
                        url: '/providers/' + fltrObj.provider.id + '/tags/' + tagName
                    };
                    genSevs.promiseGet(param).then(function (tagResult) {
                        $scope.isLoadingTagValue = false;
                        for (var key in $scope.newEnt[valueType].catalystEntityMapping) {
                            $scope.newEnt[valueType].catalystEntityMapping[key].tagValues = [];
                        }
                        ;
                        disTgMap[type] = tagResult.values;
                    });
                }
            };
            disTgMap.save =function(){
                console.log($scope.newEnt);
                var param = {
                    inlineLoader: true,
                    url: '/providers/' + fltrObj.provider.id + '/tags-mappings',
                    data:$scope.newEnt
                };
                genSevs.promisePost(param).then(function (tagResult) {
                  console.log(tagResult);
                });
            };
            $rootScope.applyFilter =function(filterApp,period){
                analyticsServices.applyFilter(true,null);
                disTgMap.getAllTags();
            };
            disTgMap.getAllTags();

        }]);
})(angular);